import { createHash } from "node:crypto";
import fs from "node:fs";
import { pipeline } from "node:stream/promises";

export const USER_AGENT = "cubehold (self-hosted Minecraft server manager)";

export class HttpError extends Error {
  constructor(
    public readonly url: string,
    public readonly status: number,
  ) {
    super(`HTTP ${status} for ${url}`);
  }
}

export async function fetchJson<T>(
  url: string,
  timeoutMs = 15_000,
  init: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/json",
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new HttpError(url, res.status);
  return (await res.json()) as T;
}

export async function fetchText(url: string, timeoutMs = 15_000): Promise<string> {
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new HttpError(url, res.status);
  return res.text();
}

export interface DownloadOptions {
  /** Expected digest, hex encoded. */
  sha1?: string;
  sha256?: string;
  sha512?: string;
  md5?: string;
  onProgress?: (received: number, total: number | null) => void;
  timeoutMs?: number;
}

/**
 * Stream a URL to disk, verifying the digest if one is given. Writes to a
 * temporary file and renames on success so a partial download never
 * masquerades as a complete one.
 */
export async function downloadFile(url: string, dest: string, opts: DownloadOptions = {}) {
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10 * 60_000),
    redirect: "follow",
  });
  if (!res.ok || !res.body) throw new HttpError(url, res.status);

  const total = Number(res.headers.get("content-length")) || null;
  // Strongest digest the source offers.
  const [algo, expected] = opts.sha512
    ? ["sha512", opts.sha512]
    : opts.sha256
      ? ["sha256", opts.sha256]
      : opts.sha1
        ? ["sha1", opts.sha1]
        : opts.md5
          ? ["md5", opts.md5]
          : [null, undefined];
  const hash = algo ? createHash(algo) : null;
  let received = 0;
  let lastReport = 0;

  const tmp = `${dest}.part`;
  await fs.promises.mkdir(dirnameOf(dest), { recursive: true });

  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      hash?.update(chunk);
      const now = Date.now();
      if (opts.onProgress && (now - lastReport > 250 || received === total)) {
        lastReport = now;
        opts.onProgress(received, total);
      }
      controller.enqueue(chunk);
    },
  });

  await pipeline(res.body.pipeThrough(counter), fs.createWriteStream(tmp));
  opts.onProgress?.(received, total ?? received);

  if (hash && expected) {
    const actual = hash.digest("hex");
    if (actual !== expected.toLowerCase()) {
      await fs.promises.rm(tmp, { force: true });
      throw new Error(`Checksum mismatch for ${url}: expected ${expected}, got ${actual}`);
    }
  }
  await fs.promises.rename(tmp, dest);
}

function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : ".";
}
