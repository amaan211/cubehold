import { randomBytes } from "node:crypto";
import { USER_AGENT } from "@cubehold/mc";

/**
 * playit.gg: a free tunnel for game servers that works behind any router,
 * CGNAT included. Their open-source agent (playitd) keeps an outbound
 * connection to playit's network and forwards players to a local port.
 *
 * The panel links an agent to the user's playit account with the same claim
 * flow as `playit setup`, runs the official playitd with that secret, and
 * reads the agent's tunnels to show addresses. Agent secrets cannot create
 * tunnels (the API only lets them read), so the user adds the tunnel on
 * playit.gg and the panel picks it up.
 * API shapes: https://github.com/playit-cloud/playit-agent/blob/master/packages/api_client/src/api.rs
 */

export const PLAYIT_API = "https://api.playit.gg";
const RELEASES = "https://api.github.com/repos/playit-cloud/playit-agent/releases/latest";

export class PlayitError extends Error {
  constructor(
    readonly kind: "fail" | "error" | "http",
    readonly detail: unknown,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, body: unknown, secret?: string): Promise<T> {
  const res = await fetch(`${PLAYIT_API}${path}`, {
    method: "POST",
    headers: {
      "user-agent": USER_AGENT,
      "content-type": "application/json",
      accept: "application/json",
      ...(secret ? { authorization: `Agent-Key ${secret.trim()}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 429)
    throw new PlayitError("http", 429, "playit.gg is rate limiting; try again shortly");
  const text = await res.text();
  let json: { status?: string; data?: unknown };
  try {
    json = JSON.parse(text);
  } catch {
    throw new PlayitError("http", res.status, `playit.gg answered HTTP ${res.status}`);
  }
  if (json.status === "success") return json.data as T;
  const detail = json.data;
  throw new PlayitError(
    json.status === "fail" ? "fail" : "error",
    detail,
    `playit.gg: ${describeDetail(detail)}`,
  );
}

function describeDetail(d: unknown): string {
  if (typeof d === "string") return d;
  // Errors look like {"type":"auth","message":"InvalidAgentKey"}.
  const m = (d as { message?: unknown } | null)?.message;
  if (typeof m === "string") return m;
  if (d && typeof d === "object") {
    const [k, v] = Object.entries(d as Record<string, unknown>)[0] ?? [];
    if (k) return typeof v === "string" ? `${k} ${v}` : k;
  }
  return "request failed";
}

/** True when playit.gg says the agent secret is no longer valid (agent deleted on the website). */
export function isInvalidSecret(err: unknown): boolean {
  if (!(err instanceof PlayitError) || err.kind !== "error") return false;
  const auth = (err.detail as { type?: string; message?: unknown } | null) ?? null;
  const text = JSON.stringify(auth ?? "");
  return /InvalidAgentKey|NoLongerValid|AccountDoesNotExist/.test(text);
}

// --- claiming (linking an agent to an account) ---------------------------------------

export type ClaimState = "WaitingForUserVisit" | "WaitingForUser" | "UserAccepted" | "UserRejected";

/** Ten hex characters, like `playit claim generate`. */
export function generateClaimCode(): string {
  return randomBytes(5).toString("hex");
}

export function claimUrl(code: string): string {
  if (!/^[0-9a-f]{10}$/.test(code)) throw new Error("Invalid claim code");
  return `https://playit.gg/claim/${code}`;
}

/** Poll this until the user approves the agent in their browser. */
export function claimSetup(code: string, version: string): Promise<ClaimState> {
  return call<ClaimState>("/claim/setup", { code, agent_type: "assignable", version });
}

/** After approval: the new agent's secret key. */
export async function claimExchange(code: string): Promise<string> {
  const r = await call<{ secret_key: string }>("/claim/exchange", { code });
  return r.secret_key;
}

// --- agent data ---------------------------------------------------------------------

export interface PlayitTunnel {
  id: string;
  name: string;
  /** What players type: "name.gl.joinmc.link" for Java tunnels, or "ip:port". */
  address: string;
  tunnelType: string | null;
  tunnelTypeLabel: string;
  portType: "tcp" | "udp" | "both";
  /** Where the agent sends players on this machine. */
  localIp: string;
  localPort: number | null;
  disabledReason: string | null;
}

export interface PlayitRunData {
  agentId: string;
  tunnels: PlayitTunnel[];
  pending: Array<{ id: string; name: string; tunnelTypeLabel: string; status: string }>;
  notices: Array<{ priority: string; message: string; link: string | null }>;
  accountStatus: "guest" | "email-not-verified" | "verified" | string;
  premium: boolean;
}

interface RawRunData {
  agent_id: string;
  tunnels: Array<{
    id: string;
    name: string;
    display_address: string;
    port_type: "tcp" | "udp" | "both";
    tunnel_type: string | null;
    tunnel_type_display: string;
    agent_config: { fields: Array<{ name: string; value: string }> };
    disabled_reason: string | null;
  }>;
  pending: Array<{ id: string; name: string; tunnel_type_display: string; status_msg: string }>;
  notices: Array<{ priority: string; message: string; resolve_link: string | null }>;
  permissions: { has_premium: boolean; account_status: string };
}

export async function agentRundata(secret: string): Promise<PlayitRunData> {
  const r = await call<RawRunData>("/v1/agents/rundata", {}, secret);
  return parseRundata(r);
}

export function parseRundata(r: RawRunData): PlayitRunData {
  return {
    agentId: r.agent_id,
    tunnels: r.tunnels.map((t) => {
      const field = (name: string) =>
        t.agent_config?.fields?.find((f) => f.name === name)?.value?.trim() || null;
      const port = Number(field("local_port"));
      // Same fallback as the agent: without local_port it uses the public port.
      const fallbackPort = Number(/:(\d+)$/.exec(t.display_address)?.[1]);
      return {
        id: t.id,
        name: t.name,
        address: t.display_address,
        tunnelType: t.tunnel_type,
        tunnelTypeLabel: t.tunnel_type_display,
        portType: t.port_type,
        localIp: field("local_ip") ?? "127.0.0.1",
        localPort: port > 0 ? port : fallbackPort > 0 ? fallbackPort : null,
        disabledReason: t.disabled_reason,
      };
    }),
    pending: r.pending.map((p) => ({
      id: p.id,
      name: p.name,
      tunnelTypeLabel: p.tunnel_type_display,
      status: p.status_msg,
    })),
    notices: r.notices.map((n) => ({
      priority: n.priority,
      message: n.message,
      link: n.resolve_link,
    })),
    accountStatus: r.permissions.account_status,
    premium: r.permissions.has_premium,
  };
}

/**
 * Ask playit.gg to create a tunnel for this agent. playit.gg may refuse
 * this for agent keys (tunnels are normally added on its website); callers
 * fall back to showing the steps.
 */
export async function createTunnel(
  secret: string,
  t: {
    agentId: string;
    name: string;
    type: "minecraft-java" | "minecraft-bedrock";
    localIp: string;
    localPort: number;
  },
): Promise<string> {
  const r = await call<{ id: string }>(
    "/v1/tunnels/create",
    {
      ports: { type: "tunnel-type", details: t.type },
      origin: {
        type: "agent",
        data: {
          agent_id: t.agentId,
          config: {
            fields: [
              { name: "local_ip", value: t.localIp },
              { name: "local_port", value: String(t.localPort) },
            ],
          },
        },
      },
      enabled: true,
      alloc: null,
      name: t.name.replace(/[^\x20-\x7e]/g, "").slice(0, 60) || "cubehold",
      firewall_id: null,
    },
    secret,
  );
  return r.id;
}

/** Why playit.gg refused to create a tunnel, in words, and whether the website is the only way. */
export function describeCreateError(err: unknown): { message: string; websiteOnly: boolean } {
  if (!(err instanceof PlayitError)) {
    return { message: err instanceof Error ? err.message : String(err), websiteOnly: false };
  }
  const text = JSON.stringify(err.detail ?? "");
  if (/RequiresVerifiedAccount|EmailMustBeVerified/.test(text)) {
    return { message: "Verify your email on playit.gg first, then try again.", websiteOnly: false };
  }
  if (
    /RequiresPlayitPremium|PublicPortRequiresPlayitPremium|RegionRequiresPlayitPremium/.test(text)
  ) {
    return { message: "That tunnel needs playit.gg Premium.", websiteOnly: false };
  }
  if (
    err.kind === "error" ||
    /ScopeNotAllowed|InvalidAuthType|AuthRequired|PathNotFound/.test(text)
  ) {
    return { message: "playit.gg only lets you add tunnels on its website.", websiteOnly: true };
  }
  return { message: err.message, websiteOnly: false };
}

// --- the agent binary -----------------------------------------------------------------

export interface PlayitRelease {
  version: string;
  asset: { name: string; url: string; sha256: string | null; sizeBytes: number };
}

/**
 * Release asset of the playit daemon for this platform. Windows gets the
 * Authenticode-signed build. There is no macOS build.
 */
export function playitAssetName(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === "win32") {
    if (arch === "x64" || arch === "arm64") return "playit-windows-x86_64-signed.exe";
    if (arch === "ia32") return "playit-windows-x86-signed.exe";
  }
  if (platform === "linux") {
    const a = { x64: "amd64", arm64: "aarch64", arm: "armv7", ia32: "i686" }[arch];
    if (a) return `playit-linux-${a}`;
  }
  return null;
}

/** The newest release from GitHub, with the SHA-256 GitHub records for the asset. */
export async function latestPlayitRelease(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Promise<PlayitRelease> {
  const name = playitAssetName(platform, arch);
  if (!name) throw new Error(`playit.gg has no agent for ${platform}/${arch}`);
  const res = await fetch(RELEASES, {
    headers: { "user-agent": USER_AGENT, accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} for the playit release`);
  const rel = (await res.json()) as {
    tag_name: string;
    assets: Array<{ name: string; browser_download_url: string; digest?: string; size: number }>;
  };
  const asset = rel.assets.find((a) => a.name === name);
  if (!asset) throw new Error(`playit ${rel.tag_name} has no ${name}`);
  const sha = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? "")?.[1] ?? null;
  return {
    version: rel.tag_name.replace(/^v/, ""),
    asset: { name, url: asset.browser_download_url, sha256: sha, sizeBytes: asset.size },
  };
}
