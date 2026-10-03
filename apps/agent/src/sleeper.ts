import net from "node:net";

/**
 * Stand-in listener for a server stopped for being idle. It answers
 * server-list pings with a "sleeping" MOTD, and when a player tries to join
 * it tells them to reconnect in a moment, closes the port and asks for the
 * real server to be started (lazymc-style wake-on-join).
 *
 * Speaks just enough of the Java Edition protocol: handshake, status
 * request/ping, and login start. See https://minecraft.wiki/w/Java_Edition_protocol
 */

export interface SleeperOptions {
  port: number;
  /** server-ip from server.properties; empty listens on every interface. */
  host?: string;
  motd: string;
  maxPlayers: number;
  /** Called once, after the port is closed, with the joining player's name if known. */
  onWake?: (player: string | null) => void;
  /**
   * Connection test instead of wake-on-join: the MOTD is shown as is and
   * joining only explains that this is a test.
   */
  probe?: boolean;
}

const IDLE_SOCKET_MS = 10_000;

export class Sleeper {
  #server: net.Server | null = null;
  #woken = false;
  readonly port: number;

  constructor(private readonly opts: SleeperOptions) {
    this.port = opts.port;
  }

  listen(): Promise<void> {
    const server = net.createServer((socket) => this.#handle(socket));
    this.#server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ port: this.opts.port, host: this.opts.host || undefined }, () => {
        server.off("error", reject);
        server.on("error", () => {});
        resolve();
      });
    });
  }

  close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => resolve());
      // close() waits for open sockets; they time out on their own.
    });
  }

  #handle(socket: net.Socket): void {
    socket.setTimeout(IDLE_SOCKET_MS, () => socket.destroy());
    socket.on("error", () => {});
    let buf: Buffer = Buffer.alloc(0);
    let state: "handshake" | "status" | "login" | "done" = "handshake";
    let protocol = 0;

    const onPackets = () => {
      for (;;) {
        const packet = readPacket(buf);
        if (!packet) return;
        buf = buf.subarray(packet.size);
        const r = new Reader(packet.body);
        const id = r.varInt();
        if (state === "handshake" && id === 0x00) {
          protocol = r.varInt();
          r.string(); // address
          r.skip(2); // port
          // 1 = status; 2 = login; 3 = transfer (treated as login)
          state = r.varInt() === 1 ? "status" : "login";
        } else if (state === "status" && id === 0x00) {
          socket.write(packetOf(0x00, stringField(JSON.stringify(this.#status(protocol)))));
        } else if (state === "status" && id === 0x01) {
          socket.end(packetOf(0x01, packet.body.subarray(1)));
          state = "done";
          return;
        } else if (state === "login" && id === 0x00) {
          let player: string | null = null;
          try {
            player = r.string();
          } catch {
            player = null;
          }
          const message = this.opts.probe
            ? {
                text: "",
                extra: [
                  { text: "Connection test from the server panel.\n", color: "yellow" },
                  {
                    text: "Your connection works; the server itself is not running.",
                    color: "gray",
                  },
                ],
              }
            : {
                text: "",
                extra: [
                  { text: "The server is starting up.\n", color: "yellow" },
                  { text: "Reconnect in about 30 seconds.", color: "gray" },
                ],
              };
          socket.end(packetOf(0x00, stringField(JSON.stringify(message))));
          state = "done";
          if (!this.opts.probe) this.#wake(player);
          return;
        } else {
          socket.destroy();
          return;
        }
      }
    };

    socket.on("data", (chunk) => {
      if (state === "done") return;
      buf = Buffer.concat([buf, chunk]);
      if (state === "handshake" && buf[0] === 0xfe) {
        socket.destroy(); // legacy (pre-1.7) ping
        return;
      }
      try {
        onPackets();
      } catch {
        socket.destroy(); // malformed input; never let it reach the daemon
      }
    });
  }

  #status(protocol: number) {
    if (this.opts.probe) {
      return {
        version: { name: "Connection test", protocol },
        players: { max: 0, online: 0 },
        description: { text: this.opts.motd },
      };
    }
    const motd = this.opts.motd.split("\n")[0] ?? "";
    return {
      version: { name: "Sleeping", protocol },
      players: { max: this.opts.maxPlayers, online: 0 },
      description: {
        text: "",
        extra: [{ text: `${motd}\n` }, { text: "Sleeping · join to wake it up", color: "gray" }],
      },
    };
  }

  #wake(player: string | null): void {
    if (this.#woken) return;
    this.#woken = true;
    void this.close().then(() => this.opts.onWake?.(player));
  }
}

// --- wire format ----------------------------------------------------------------

function readVarInt(buf: Buffer, offset: number): { value: number; size: number } | null {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buf.length) return null;
    const byte = buf[offset + i] as number;
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) return { value, size: i + 1 };
  }
  throw new Error("VarInt too long");
}

function readPacket(buf: Buffer): { body: Buffer; size: number } | null {
  const len = readVarInt(buf, 0);
  if (!len) return null;
  if (len.value > 64 * 1024) throw new Error("packet too large");
  if (buf.length < len.size + len.value) return null;
  return { body: buf.subarray(len.size, len.size + len.value), size: len.size + len.value };
}

function varInt(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function stringField(s: string): Buffer {
  const data = Buffer.from(s, "utf8");
  return Buffer.concat([varInt(data.length), data]);
}

function packetOf(id: number, payload: Buffer): Buffer {
  const body = Buffer.concat([varInt(id), payload]);
  return Buffer.concat([varInt(body.length), body]);
}

class Reader {
  #pos = 0;
  constructor(private readonly buf: Buffer) {}
  varInt(): number {
    const r = readVarInt(this.buf, this.#pos);
    if (!r) throw new Error("truncated VarInt");
    this.#pos += r.size;
    return r.value;
  }
  string(): string {
    const len = this.varInt();
    if (this.#pos + len > this.buf.length) throw new Error("truncated string");
    const s = this.buf.subarray(this.#pos, this.#pos + len).toString("utf8");
    this.#pos += len;
    return s;
  }
  skip(n: number): void {
    this.#pos += n;
  }
}
