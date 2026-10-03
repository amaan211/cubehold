import { CloudError, type CloudErrorCode, type FetchLike } from "./types.js";

const USER_AGENT = "cubehold/0.0.1 (self-hosted Minecraft server manager)";

export interface RestOptions {
  /** e.g. "https://api.hetzner.cloud/v1" */
  base: string;
  token: string;
  /** Shown in error messages. */
  provider: string;
  fetch?: FetchLike;
}

/** Pull a readable message out of any of the providers' error bodies. */
export function errorText(body: unknown): string | null {
  if (!body || typeof body !== "object") return typeof body === "string" && body ? body : null;
  const b = body as Record<string, unknown>;
  const e = b.error;
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") {
    return (e as { message: string }).message; // Hetzner
  }
  if (typeof e === "string") return e; // Vultr
  if (Array.isArray(b.errors)) {
    // Linode
    return b.errors
      .map((x: { field?: string; reason?: string }) =>
        x.field ? `${x.field}: ${x.reason}` : (x.reason ?? ""),
      )
      .filter(Boolean)
      .join("; ");
  }
  if (typeof b.message === "string") return b.message; // DigitalOcean
  return null;
}

/**
 * JSON over HTTPS with a bearer token. Failed GETs are retried on rate
 * limits and server errors; every failure becomes a CloudError.
 */
export class RestClient {
  #fetch: FetchLike;

  constructor(private readonly opts: RestOptions) {
    this.#fetch = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    return this.request<T>("GET", path, undefined, query) as Promise<T>;
  }

  /** GET that answers null for 404 instead of throwing. */
  async find<T>(path: string): Promise<T | null> {
    try {
      return await this.get<T>(path);
    } catch (err) {
      if (err instanceof CloudError && err.code === "not-found") return null;
      throw err;
    }
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body ?? {}) as Promise<T>;
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, body) as Promise<T>;
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body) as Promise<T>;
  }

  /** DELETE; a resource that is already gone counts as deleted. */
  async del(path: string, body?: unknown): Promise<void> {
    try {
      await this.request("DELETE", path, body);
    } catch (err) {
      if (err instanceof CloudError && err.code === "not-found") return;
      throw err;
    }
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
  ): Promise<T | null> {
    const url = new URL(this.opts.base + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const attempts = method === "GET" ? 3 : 1;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await this.#fetch(url.toString(), {
          method,
          headers: {
            authorization: `Bearer ${this.opts.token}`,
            "user-agent": USER_AGENT,
            accept: "application/json",
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        if (attempt < attempts) {
          await sleep(1_000 * attempt);
          continue;
        }
        throw new CloudError(
          "unavailable",
          `Could not reach ${this.opts.provider}: ${err instanceof Error ? err.message : err}`,
        );
      }
      const text = await res.text();
      let json: unknown = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = text;
        }
      }
      if (res.ok) return json as T;
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < attempts) {
        const after = Number(res.headers.get("retry-after"));
        await sleep(
          Number.isFinite(after) && after > 0 ? Math.min(after, 10) * 1000 : 1_500 * attempt,
        );
        continue;
      }
      throw this.#error(res.status, errorText(json));
    }
  }

  #error(status: number, detail: string | null): CloudError {
    const p = this.opts.provider;
    const code: CloudErrorCode =
      status === 401
        ? "auth"
        : status === 403
          ? "permission"
          : status === 404
            ? "not-found"
            : status === 429
              ? "rate-limit"
              : status >= 500
                ? "unavailable"
                : "invalid";
    const message =
      code === "auth"
        ? `${p} did not accept the API token${detail ? ` (${detail})` : ""}. Create a new one and paste it again.`
        : code === "permission"
          ? `The ${p} token is not allowed to do this${detail ? ` (${detail})` : ""}. Give it read and write access.`
          : code === "rate-limit"
            ? `${p} asks the panel to slow down; try again in a minute.`
            : code === "unavailable"
              ? `${p} is having trouble (HTTP ${status}); try again later.`
              : `${p}: ${detail ?? `HTTP ${status}`}`;
    return new CloudError(code, message, status);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Two-letter continent guess from a country code, for grouping regions. */
export function continentOf(country: string | null): import("./types.js").CloudRegion["continent"] {
  if (!country) return null;
  const c = country.toUpperCase();
  if (["US", "CA", "MX"].includes(c)) return "North America";
  if (["BR", "CL", "AR", "CO"].includes(c)) return "South America";
  if (["AU", "NZ"].includes(c)) return "Oceania";
  if (["ZA", "NG", "KE", "EG"].includes(c)) return "Africa";
  if (["JP", "SG", "IN", "KR", "HK", "ID", "IL", "AE", "BH", "TW", "MY", "TH"].includes(c)) {
    return "Asia";
  }
  return "Europe";
}
