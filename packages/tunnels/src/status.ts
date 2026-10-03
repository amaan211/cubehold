import dns from "node:dns/promises";
import net from "node:net";
import { USER_AGENT } from "@cubehold/mc";

export interface StatusResult {
  /** Where the ping actually went after SRV lookup. */
  host: string;
  port: number;
  latencyMs: number;
  version: string | null;
  protocol: number | null;
  players: { online: number; max: number } | null;
  /** Plain-text MOTD, colour codes removed. */
  motd: string;
}

/**
 * Minecraft Java server-list ping (handshake, status, ping). Follows the
 * _minecraft._tcp SRV record like the game does when no port is given,
 * which playit.gg's joinmc.link addresses rely on.
 * https://minecraft.wiki/w/Java_Edition_protocol/Server_List_Ping
 */
export async function pingJava(
  address: string,
  opts: { timeoutMs?: number } = {},
): Promise<StatusResult> {
  const { host, port, explicitPort } = splitAddress(address);
  let target = { host, port };
  if (!explicitPort && net.isIP(host) === 0) {
    const srv = await dns.resolveSrv(`_minecraft._tcp.${host}`).catch(() => []);
    const first = srv.sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0];
    if (first) target = { host: first.name, port: first.port };
  }
  return statusPing(target.host, target.port, opts.timeoutMs ?? 6_000);
}

export function splitAddress(address: string): {
  host: string;
  port: number;
  explicitPort: boolean;
} {
  const a = address.trim();
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(a);
  if (v6) return { host: v6[1] as string, port: Number(v6[2] ?? 25565), explicitPort: !!v6[2] };
  const m = /^([^:]+)(?::(\d+))?$/.exec(a);
  if (!m) return { host: a, port: 25565, explicitPort: false };
  return { host: m[1] as string, port: Number(m[2] ?? 25565), explicitPort: !!m[2] };
}

function statusPing(host: string, port: number, timeoutMs: number): Promise<StatusResult> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    let status: Record<string, unknown> | null = null;
    let sentAt = 0;
    const fail = (err: Error) => {
      socket.destroy();
      reject(err);
    };
    socket.setTimeout(timeoutMs, () => fail(new Error(`No answer from ${host}:${port}`)));
    socket.on("error", (err) => fail(err));
    socket.on("connect", () => {
      const hostField = stringField(host);
      const portField = Buffer.alloc(2);
      portField.writeUInt16BE(port);
      socket.write(packet(0x00, Buffer.concat([varInt(767), hostField, portField, varInt(1)])));
      socket.write(packet(0x00, Buffer.alloc(0)));
    });
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const len = readVarInt(buf, 0);
        if (!len || buf.length < len.size + len.value) return;
        const body = buf.subarray(len.size, len.size + len.value);
        buf = buf.subarray(len.size + len.value);
        const id = readVarInt(body, 0);
        if (!id) return fail(new Error("Malformed reply"));
        if (id.value === 0x00 && !status) {
          const strLen = readVarInt(body, id.size);
          if (!strLen) return fail(new Error("Malformed reply"));
          const start = id.size + strLen.size;
          try {
            status = JSON.parse(body.subarray(start, start + strLen.value).toString("utf8"));
          } catch {
            return fail(new Error("Not a Minecraft server"));
          }
          const payload = Buffer.alloc(8);
          payload.writeBigInt64BE(BigInt(Date.now()));
          sentAt = performance.now();
          socket.write(packet(0x01, payload));
        } else if (id.value === 0x01 && status) {
          const latencyMs = Math.round(performance.now() - sentAt);
          socket.destroy();
          resolve(toResult(host, port, latencyMs, status));
          return;
        }
      }
    });
    socket.on("close", () => {
      // Some servers (and our sleeper) close after the status reply without a pong.
      if (status) resolve(toResult(host, port, 0, status));
    });
  });
}

function toResult(
  host: string,
  port: number,
  latencyMs: number,
  s: Record<string, unknown>,
): StatusResult {
  const version = (s.version ?? {}) as { name?: string; protocol?: number };
  const players = s.players as { online?: number; max?: number } | undefined;
  return {
    host,
    port,
    latencyMs,
    version: typeof version.name === "string" ? version.name : null,
    protocol: typeof version.protocol === "number" ? version.protocol : null,
    players: players ? { online: players.online ?? 0, max: players.max ?? 0 } : null,
    motd: chatToText(s.description),
  };
}

/** Flatten a chat component (string, {text, extra}, or a list) to plain text. */
export function chatToText(c: unknown): string {
  if (typeof c === "string") return c.replace(/§./g, "");
  if (Array.isArray(c)) return c.map(chatToText).join("");
  if (c && typeof c === "object") {
    const o = c as { text?: unknown; extra?: unknown; translate?: unknown };
    return (
      (typeof o.text === "string" ? o.text.replace(/§./g, "") : "") +
      (typeof o.translate === "string" && typeof o.text !== "string" ? o.translate : "") +
      (o.extra ? chatToText(o.extra) : "")
    );
  }
  return "";
}

// --- checking from outside ------------------------------------------------------------

export interface OutsideCheck {
  online: boolean;
  /** When the checker contacted the server (it caches results for about a minute). */
  retrievedAt: number;
  expiresAt: number;
  motd: string | null;
  version: string | null;
  players: { online: number; max: number } | null;
}

/**
 * Ask mcstatus.io to ping an address from the internet. It caches each
 * address for about a minute; `retrievedAt` says how fresh the answer is.
 */
export async function checkFromOutside(host: string, port: number): Promise<OutsideCheck> {
  const address = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
  const res = await fetch(
    `https://api.mcstatus.io/v2/status/java/${encodeURIComponent(address)}?query=false`,
    {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!res.ok) throw new Error(`mcstatus.io answered HTTP ${res.status}`);
  const j = (await res.json()) as {
    online?: boolean;
    retrieved_at?: number;
    expires_at?: number;
    motd?: { clean?: string };
    version?: { name_clean?: string };
    players?: { online?: number; max?: number };
  };
  return {
    online: j.online === true,
    retrievedAt: j.retrieved_at ?? Date.now(),
    expiresAt: j.expires_at ?? Date.now(),
    motd: j.motd?.clean ?? null,
    version: j.version?.name_clean ?? null,
    players: j.players ? { online: j.players.online ?? 0, max: j.players.max ?? 0 } : null,
  };
}

// --- wire helpers ---------------------------------------------------------------------

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

function packet(id: number, payload: Buffer): Buffer {
  const body = Buffer.concat([varInt(id), payload]);
  return Buffer.concat([varInt(body.length), body]);
}
