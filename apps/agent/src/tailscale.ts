import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { TailscaleStatus } from "./types.js";

/**
 * Tailscale through its own CLI. Tailscale runs as a system service; the
 * agent only asks it for status, starts a sign-in, and sets Funnel forwards.
 * Funnel shares one local TCP port publicly on 443, 8443 or 10000:
 * https://tailscale.com/kb/1311/tailscale-funnel
 */

export const FUNNEL_PORTS = [443, 8443, 10000] as const;

export function findTailscale(): string | null {
  const candidates =
    process.platform === "win32"
      ? [
          path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Tailscale", "tailscale.exe"),
          path.join(
            process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
            "Tailscale",
            "tailscale.exe",
          ),
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
            "/usr/local/bin/tailscale",
            "/opt/homebrew/bin/tailscale",
          ]
        : ["/usr/bin/tailscale", "/usr/local/bin/tailscale", "/usr/sbin/tailscale"];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

function run(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code: unknown = err ? (err as { code?: unknown }).code : 0;
        resolve({
          code: typeof code === "number" ? code : err ? 1 : 0,
          out: `${stdout}${stderr}` || (err?.message ?? ""),
        });
      },
    );
  });
}

export function parseTailscaleStatus(
  json: unknown,
): Omit<TailscaleStatus, "installed" | "funnel" | "error"> {
  const s = (json ?? {}) as {
    BackendState?: string;
    AuthURL?: string;
    Self?: { DNSName?: string; TailscaleIPs?: string[] };
    CurrentTailnet?: { Name?: string } | null;
  };
  return {
    state: s.BackendState ?? null,
    authUrl: s.AuthURL || null,
    ips: s.Self?.TailscaleIPs ?? [],
    dnsName: s.Self?.DNSName ? s.Self.DNSName.replace(/\.$/, "") : null,
    tailnet: s.CurrentTailnet?.Name ?? null,
  };
}

/** Funnel/serve config: {"TCP":{"10000":{"TCPForward":"localhost:25565"}},"AllowFunnel":{"host:10000":true}}. */
export function parseFunnelStatus(json: unknown): TailscaleStatus["funnel"] {
  const s = (json ?? {}) as {
    TCP?: Record<string, { TCPForward?: string }>;
    AllowFunnel?: Record<string, boolean>;
  };
  const allowed = Object.entries(s.AllowFunnel ?? {})
    .filter(([, v]) => v)
    .map(([k]) => Number(k.split(":").pop()));
  return Object.entries(s.TCP ?? {})
    .filter(([, v]) => v.TCPForward)
    .map(([port, v]) => ({
      port: Number(port),
      target: v.TCPForward as string,
      public: allowed.includes(Number(port)),
    }));
}

export async function tailscaleStatus(): Promise<TailscaleStatus> {
  const bin = findTailscale();
  const empty: TailscaleStatus = {
    installed: false,
    state: null,
    authUrl: null,
    ips: [],
    dnsName: null,
    tailnet: null,
    funnel: [],
    error: null,
  };
  if (!bin) return empty;
  const status = await run(bin, ["status", "--json"], 15_000);
  let parsed: ReturnType<typeof parseTailscaleStatus>;
  try {
    parsed = parseTailscaleStatus(JSON.parse(status.out.slice(status.out.indexOf("{"))));
  } catch {
    return {
      ...empty,
      installed: true,
      error: status.out.trim().split("\n")[0] || "Tailscale did not answer",
    };
  }
  let funnel: TailscaleStatus["funnel"] = [];
  if (parsed.state === "Running") {
    const f = await run(bin, ["funnel", "status", "--json"], 15_000);
    try {
      funnel = parseFunnelStatus(JSON.parse(f.out.slice(f.out.indexOf("{"))));
    } catch {
      funnel = [];
    }
  }
  return { ...empty, installed: true, ...parsed, funnel };
}

const URL_RE = /https:\/\/login\.tailscale\.com\/\S+/;

/**
 * `tailscale up` waits until the sign-in finishes, so it runs in the
 * background (for up to 10 minutes) and this returns the login link as soon
 * as it appears.
 */
export async function tailscaleLogin(): Promise<{ authUrl: string | null; output: string }> {
  const bin = findTailscale();
  if (!bin) throw new Error("Tailscale is not installed");
  return new Promise((resolve) => {
    const child = spawn(bin, ["up"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let done = false;
    const finish = (authUrl: string | null) => {
      if (done) return;
      done = true;
      resolve({ authUrl, output: output.trim() });
    };
    const onData = (d: Buffer) => {
      output += d.toString();
      const url = URL_RE.exec(output)?.[0];
      if (url) finish(url);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", () => finish(URL_RE.exec(output)?.[0] ?? null));
    child.on("error", (err) => {
      output += err.message;
      finish(null);
    });
    setTimeout(() => finish(null), 20_000).unref();
    setTimeout(() => child.kill(), 10 * 60_000).unref();
  });
}

export async function tailscaleFunnel(
  publicPort: number,
  localPort: number | null,
): Promise<{ ok: boolean; enableUrl: string | null; output: string }> {
  const bin = findTailscale();
  if (!bin) throw new Error("Tailscale is not installed");
  if (!FUNNEL_PORTS.includes(publicPort as (typeof FUNNEL_PORTS)[number])) {
    throw new Error("Funnel only allows ports 443, 8443 and 10000");
  }
  const args =
    localPort === null
      ? ["funnel", `--tcp=${publicPort}`, "off"]
      : ["funnel", "--bg", `--tcp=${publicPort}`, `tcp://localhost:${Math.trunc(localPort)}`];
  // When Funnel is not allowed yet the CLI prints a link and waits for it; stop waiting.
  const r = await run(bin, args, 20_000);
  const enableUrl = /https:\/\/login\.tailscale\.com\/f\/\S+/.exec(r.out)?.[0] ?? null;
  return { ok: r.code === 0 && !enableUrl, enableUrl, output: r.out.trim() };
}

export async function tailscaleInstall(): Promise<{ ok: boolean; output: string }> {
  if (process.platform !== "win32") {
    throw new Error("Install Tailscale from https://tailscale.com/download");
  }
  const r = await run(
    "winget",
    [
      "install",
      "--id",
      "Tailscale.Tailscale",
      "-e",
      "--silent",
      "--accept-package-agreements",
      "--accept-source-agreements",
    ],
    15 * 60_000,
  ).catch((err: Error) => ({ code: 1, out: err.message }));
  return { ok: r.code === 0 || findTailscale() !== null, output: r.out.trim().slice(-2000) };
}
