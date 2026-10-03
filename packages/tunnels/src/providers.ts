import { USER_AGENT } from "@cubehold/mc";

/**
 * ngrok and Cloudflare Tunnel: where to get the programs, how to configure
 * them, and how to read what they report. The agent runs them; the panel
 * keeps the tokens.
 */

// --- GitHub releases -------------------------------------------------------------------

export interface ReleaseAsset {
  version: string;
  name: string;
  url: string;
  /** SHA-256 that GitHub records for the upload, when it has one. */
  sha256: string | null;
  sizeBytes: number;
}

/** The newest release of a GitHub repository and one named asset of it. */
export async function latestGithubAsset(repo: string, assetName: string): Promise<ReleaseAsset> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { "user-agent": USER_AGENT, accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} for ${repo}`);
  const rel = (await res.json()) as {
    tag_name: string;
    assets: Array<{ name: string; browser_download_url: string; digest?: string; size: number }>;
  };
  const asset = rel.assets.find((a) => a.name === assetName);
  if (!asset) throw new Error(`${repo} ${rel.tag_name} has no ${assetName}`);
  return {
    version: rel.tag_name.replace(/^v/, ""),
    name: asset.name,
    url: asset.browser_download_url,
    sha256: /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? "")?.[1] ?? null,
    sizeBytes: asset.size,
  };
}

// --- ngrok ---------------------------------------------------------------------------------

/**
 * ngrok's official download (the stable channel), a zip on Windows and
 * macOS and a tgz on Linux. ngrok publishes no checksums; on Windows the
 * binary's Authenticode signature (ngrok, Inc.) is checked instead.
 */
export function ngrokDownload(
  platform: NodeJS.Platform,
  arch: string,
): { url: string; archive: "zip" | "tgz" } | null {
  const a = { x64: "amd64", arm64: "arm64", ia32: "386", arm: "arm" }[arch];
  if (!a) return null;
  const base = "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable";
  if (platform === "win32") return { url: `${base}-windows-${a}.zip`, archive: "zip" };
  if (platform === "darwin") return { url: `${base}-darwin-${a}.zip`, archive: "zip" };
  if (platform === "linux") return { url: `${base}-linux-${a}.tgz`, archive: "tgz" };
  return null;
}

/** ngrok authtokens are long strings of letters, digits and underscores. */
export function isNgrokToken(token: string): boolean {
  return /^[0-9A-Za-z_]{30,120}$/.test(token.trim());
}

export function ngrokEndpointName(serverId: string): string {
  return `cubehold-${serverId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 40)}`;
}

/**
 * Agent config (version 3) with one TCP endpoint per shared server. One
 * ngrok process carries them all: free accounts allow a single agent
 * session. The authtoken is passed as NGROK_AUTHTOKEN, never written here.
 */
export function ngrokConfig(
  endpoints: Array<{ name: string; port: number }>,
  webAddr: string,
): string {
  const lines = [
    "version: 3",
    "agent:",
    `  web_addr: ${webAddr}`,
    "  log: stdout",
    "  log_format: json",
    "  log_level: info",
    "  update_check: false",
    "endpoints:",
  ];
  for (const e of endpoints) {
    lines.push(
      `  - name: ${e.name}`,
      "    url: tcp://",
      "    upstream:",
      `      url: 127.0.0.1:${Math.trunc(e.port)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** "tcp://0.tcp.eu.ngrok.io:12345" as players type it. */
export function tcpAddress(url: string): string {
  return url.replace(/^tcp:\/\//, "");
}

// --- Cloudflare Tunnel -------------------------------------------------------------------

export function cloudflaredAssetName(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === "win32")
    return arch === "ia32" ? "cloudflared-windows-386.exe" : "cloudflared-windows-amd64.exe";
  if (platform === "linux") {
    const a = { x64: "amd64", arm64: "arm64", arm: "arm", ia32: "386" }[arch];
    return a ? `cloudflared-linux-${a}` : null;
  }
  if (platform === "darwin")
    return arch === "arm64" ? "cloudflared-darwin-arm64.tgz" : "cloudflared-darwin-amd64.tgz";
  return null;
}

/**
 * A tunnel token from the Cloudflare dashboard is base64 JSON with the
 * account ("a"), tunnel id ("t") and secret ("s"). Returns null for anything else.
 */
export function parseTunnelToken(token: string): { accountTag: string; tunnelId: string } | null {
  try {
    const j = JSON.parse(Buffer.from(token.trim(), "base64").toString("utf8")) as {
      a?: string;
      t?: string;
      s?: string;
    };
    if (!j.a || !j.t || !j.s || !/^[0-9a-f-]{36}$/i.test(j.t)) return null;
    return { accountTag: j.a, tunnelId: j.t };
  } catch {
    return null;
  }
}

/** The local port a Cloudflare ingress service points at: "tcp://localhost:25565" -> 25565. */
export function servicePort(service: string | null): number | null {
  const m = /^tcp:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d+)\/?$/i.exec(service ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * Minecraft speaks raw TCP, which Cloudflare only carries to another
 * cloudflared: each player runs this, then joins localhost:<localPort>.
 */
export function friendCommands(hostname: string, localPort = 25565) {
  const access = `access tcp --hostname ${hostname} --url 127.0.0.1:${localPort}`;
  return {
    windows: `winget install --id Cloudflare.cloudflared -e\ncloudflared ${access}`,
    mac: `brew install cloudflared\ncloudflared ${access}`,
    linux: `# install from https://pkg.cloudflare.com/ (or download cloudflared-linux-amd64 from GitHub)\ncloudflared ${access}`,
    join: localPort === 25565 ? "localhost" : `localhost:${localPort}`,
  };
}
