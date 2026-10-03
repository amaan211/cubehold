import net from "node:net";

/**
 * Minimal Source RCON client for Minecraft.
 *
 * Packet: int32 length, int32 request id, int32 type, ASCII body, two NULs.
 * Minecraft's RCON reader expects exactly one packet per socket read and
 * drops the connection otherwise, so commands are strictly one at a time.
 * Replies come as type-0 packets of at most 4096 characters; a shorter one
 * ends the reply, and a full one is followed by a short wait for more.
 */

const TYPE_RESPONSE = 0;
const TYPE_EXEC = 2;
const TYPE_AUTH = 3;
const MAX_CHUNK = 4096;
/** Minecraft reads packets into a 1460-byte buffer. */
const MAX_COMMAND_BYTES = 1446;
const MORE_CHUNKS_WAIT_MS = 250;

interface Pending {
  id: number;
  chunks: string[];
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  settle: NodeJS.Timeout | null;
}

export class RconClient {
  #socket: net.Socket | null = null;
  #buf: Buffer = Buffer.alloc(0);
  #nextId = 1;
  #pending: Pending | null = null;
  #chain: Promise<unknown> = Promise.resolve();
  #auth: { id: number; resolve: () => void; reject: (e: Error) => void } | null = null;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly password: string,
  ) {}

  get connected(): boolean {
    return this.#socket !== null && !this.#socket.destroyed && this.#auth === null;
  }

  async connect(timeoutMs = 5_000): Promise<void> {
    const socket = net.connect({ host: this.host, port: this.port });
    socket.setNoDelay(true);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("RCON connect timed out"));
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    this.#socket = socket;
    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("error", () => {
      // "close" follows
    });
    socket.on("close", () => this.#onClose());

    const id = this.#allocId();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#auth = null;
        reject(new Error("RCON login timed out"));
        socket.destroy();
      }, timeoutMs);
      this.#auth = {
        id,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      socket.write(encode(id, TYPE_AUTH, this.password));
    });
  }

  /** Run a command and return its output (may be empty). Queued behind earlier commands. */
  command(command: string, timeoutMs = 10_000): Promise<string> {
    if (Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES) {
      return Promise.reject(new Error("Command too long for RCON"));
    }
    const run = () => this.#send(command, timeoutMs);
    const result = this.#chain.then(run, run);
    this.#chain = result.catch(() => {});
    return result;
  }

  close(): void {
    this.#socket?.destroy();
    this.#socket = null;
  }

  #send(command: string, timeoutMs: number): Promise<string> {
    const socket = this.#socket;
    if (!socket || socket.destroyed || this.#auth) {
      return Promise.reject(new Error("RCON is not connected"));
    }
    const id = this.#allocId();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending = null;
        reject(new Error(`RCON command timed out: ${command}`));
      }, timeoutMs);
      this.#pending = { id, chunks: [], resolve, reject, timer, settle: null };
      socket.write(encode(id, TYPE_EXEC, command));
    });
  }

  #allocId(): number {
    const id = this.#nextId++;
    if (this.#nextId > 0x7ffffff0) this.#nextId = 1;
    return id;
  }

  #onData(chunk: Buffer): void {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    while (this.#buf.length >= 4) {
      const len = this.#buf.readInt32LE(0);
      if (len < 10 || len > 1024 * 1024) {
        this.close(); // garbage; not an RCON server
        return;
      }
      if (this.#buf.length < 4 + len) return;
      const id = this.#buf.readInt32LE(4);
      const type = this.#buf.readInt32LE(8);
      const body = this.#buf.subarray(12, 4 + len - 2).toString("utf8");
      this.#buf = this.#buf.subarray(4 + len);
      this.#onPacket(id, type, body);
    }
  }

  #onPacket(id: number, type: number, body: string): void {
    if (this.#auth) {
      // Minecraft answers the login with type 2: the request id on success, -1 on failure.
      if (id === -1) {
        const a = this.#auth;
        this.#auth = null;
        a.reject(new Error("RCON password rejected"));
        this.close();
      } else if (id === this.#auth.id && type === TYPE_EXEC) {
        const a = this.#auth;
        this.#auth = null;
        a.resolve();
      }
      return;
    }
    const p = this.#pending;
    if (type !== TYPE_RESPONSE || !p || p.id !== id) return;
    p.chunks.push(body);
    if (p.settle) clearTimeout(p.settle);
    if (body.length < MAX_CHUNK) this.#finish(p);
    else p.settle = setTimeout(() => this.#finish(p), MORE_CHUNKS_WAIT_MS);
  }

  #finish(p: Pending): void {
    if (this.#pending !== p) return;
    this.#pending = null;
    clearTimeout(p.timer);
    if (p.settle) clearTimeout(p.settle);
    p.resolve(p.chunks.join(""));
  }

  #onClose(): void {
    this.#socket = null;
    const err = new Error("RCON connection closed");
    if (this.#auth) {
      const a = this.#auth;
      this.#auth = null;
      a.reject(err);
    }
    const p = this.#pending;
    this.#pending = null;
    if (p) {
      clearTimeout(p.timer);
      if (p.settle) clearTimeout(p.settle);
      p.reject(err);
    }
  }
}

function encode(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, "utf8");
  const buf = Buffer.alloc(14 + payload.length);
  buf.writeInt32LE(10 + payload.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  buf.writeInt16LE(0, 12 + payload.length);
  return buf;
}
