import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { TunnelKind, TunnelStatus } from "@cubehold/agent";
import { downloadFile } from "@cubehold/mc";
import { LOCAL_HOST_ID } from "@cubehold/shared";
import {
  cloudflaredAssetName,
  isNgrokToken,
  latestGithubAsset,
  ngrokConfig,
  ngrokDownload,
  ngrokEndpointName,
  parseTunnelToken,
  servicePort,
  tcpAddress,
} from "@cubehold/tunnels";
import { eq } from "drizzle-orm";
import yauzl from "yauzl";
import { type Db, schema } from "../db/index.js";
import type { HostManager } from "../hosts/manager.js";
import { decryptJson, encryptJson, type KeyVault } from "../security/crypto.js";
import {
  errMessage,
  nowIso,
  ServerError,
  type ServerRow,
  type ServerService,
} from "../servers/service.js";

const UPDATE_CHECK_MS = 7 * 24 * 60 * 60_000;
/** Local status servers of the programs: ngrok's agent API and cloudflared's metrics. */
const NGROK_WEB = "127.0.0.1:4551";
const CLOUDFLARED_METRICS = "127.0.0.1:20541";

type Provider = "ngrok" | "cloudflared";
interface Stored {
  token: string;
  tunnelId?: string;
  savedAt: string;
}
interface BinaryInfo {
  version: string;
  path: string;
  checkedAt: string;
}

/**
 * ngrok and Cloudflare Tunnel. The owner pastes a token once; the panel
 * keeps it encrypted, downloads the official program (ngrok checked by its
 * Windows signature, cloudflared by GitHub's SHA-256), and the agent runs it
 * so tunnels survive the panel closing.
 *
 *  - ngrok: one process with a TCP endpoint per shared server. Random
 *    addresses change each time ngrok restarts; free accounts need a card on
 *    file for TCP.
 *  - Cloudflare Tunnel: runs a tunnel created in the Cloudflare dashboard; the
 *    public hostnames and the ports they lead to come from cloudflared itself.
 *    Players need cloudflared on their side too (Minecraft is raw TCP).
 */
export class TunnelService {
  #errors: Record<Provider, string | null> = { ngrok: null, cloudflared: null };
  #jobs = new Map<Provider, Promise<string>>();

  constructor(
    private readonly db: Db,
    private readonly servers: ServerService,
    private readonly hosts: HostManager,
    private readonly vault: KeyVault,
    private readonly dataDir: string,
  ) {}

  async init(): Promise<void> {
    const all = () => void this.reconcile().catch(() => {});
    this.hosts.onAgentConnect((hostId) => {
      if (hostId === LOCAL_HOST_ID) all();
    });
    this.vault.onUnlock(all);
    this.servers.events.on("changed", () => void this.reconcileNgrok().catch(() => {}));
    this.servers.events.on("removed", () => void this.reconcileNgrok().catch(() => {}));
    await this.reconcile();
  }

  reconcile(): Promise<unknown> {
    return Promise.all([this.reconcileNgrok(), this.reconcileCloudflared()]);
  }

  // --- ngrok ------------------------------------------------------------------------------

  async ngrokStatus() {
    const cred = await this.#credential("ngrok");
    const tunnel = await this.#tunnel("ngrok");
    const rows = await this.#shared();
    return {
      supported: ngrokDownload(process.platform, process.arch) !== null,
      configured: !!cred,
      locked: !!cred && !this.vault.isUnlocked(),
      tunnel,
      error: tunnel?.error ?? this.#errors.ngrok,
      shared: rows.map((r) => ({
        serverId: r.id,
        name: r.name,
        port: r.port,
        address: this.#ngrokAddress(tunnel, r.id),
      })),
    };
  }

  async ngrokSetToken(token: string) {
    const t = token.trim().replace(/^ngrok config add-authtoken\s+/i, "");
    if (!isNgrokToken(t)) {
      throw new ServerError("VALIDATION", "That does not look like an ngrok authtoken", {
        token: "Copy the token from dashboard.ngrok.com, under Your Authtoken",
      });
    }
    await this.#store("ngrok", { token: t, savedAt: nowIso() });
    await this.reconcileNgrok();
    return this.ngrokStatus();
  }

  async ngrokShare(serverId: string, enabled: boolean) {
    await this.servers.row(serverId);
    await this.servers.updateSettings(serverId, { ngrok: enabled });
    await this.reconcileNgrok();
    return this.ngrokStatus();
  }

  async reconcileNgrok(): Promise<void> {
    const agent = this.hosts.agentFor(LOCAL_HOST_ID);
    const cred = await this.#credential("ngrok");
    const shared = await this.#shared();
    if (!cred || shared.length === 0) {
      this.#errors.ngrok = null;
      await agent.setTunnel("ngrok", null).catch(() => {});
      return;
    }
    if (!this.vault.isUnlocked()) return;
    try {
      const { token } = this.#decrypt("ngrok", cred.encrypted);
      const binary = await this.#binary("ngrok");
      const dir = path.join(this.dataDir, "ngrok");
      const config = path.join(dir, "cubehold-ngrok.yml");
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(
        config,
        ngrokConfig(
          shared.map((r) => ({ name: ngrokEndpointName(r.id), port: r.port })),
          NGROK_WEB,
        ),
      );
      await agent.setTunnel("ngrok", {
        binary,
        args: ["start", "--all", "--config", config],
        env: { NGROK_AUTHTOKEN: token },
        statusAddr: NGROK_WEB,
        pidFile: path.join(dir, "ngrok.pid"),
        redact: [token],
      });
      this.#errors.ngrok = null;
    } catch (err) {
      this.#errors.ngrok = errMessage(err);
    }
  }

  #ngrokAddress(tunnel: TunnelStatus | null, serverId: string): string | null {
    const name = ngrokEndpointName(serverId);
    const e = tunnel?.endpoints.find((x) => x.name === name);
    return e ? tcpAddress(e.url) : null;
  }

  async #shared(): Promise<ServerRow[]> {
    const rows = await this.db
      .select()
      .from(schema.servers)
      .where(eq(schema.servers.hostId, LOCAL_HOST_ID));
    return rows.filter((r) => r.settings?.ngrok === true && !r.meta?.deletingSince);
  }

  // --- Cloudflare Tunnel ------------------------------------------------------------------

  async cloudflaredStatus() {
    const cred = await this.#credential("cloudflared");
    const tunnel = await this.#tunnel("cloudflared");
    let tunnelId: string | null = null;
    if (cred && this.vault.isUnlocked()) {
      tunnelId = this.#decrypt("cloudflared", cred.encrypted).tunnelId ?? null;
    }
    return {
      supported: cloudflaredAssetName(process.platform, process.arch) !== null,
      configured: !!cred,
      locked: !!cred && !this.vault.isUnlocked(),
      tunnelId,
      tunnel,
      error: tunnel?.error ?? this.#errors.cloudflared,
      routes: (tunnel?.endpoints ?? []).map((e) => ({
        hostname: e.url,
        service: e.target,
        port: servicePort(e.target),
      })),
    };
  }

  async cloudflaredSetToken(token: string) {
    const t = token
      .trim()
      .replace(/^.*(?:--token|service install)\s+/i, "")
      .trim();
    const parsed = parseTunnelToken(t);
    if (!parsed) {
      throw new ServerError("VALIDATION", "That does not look like a Cloudflare tunnel token", {
        token: "Copy the token shown when you install the connector (the long text after --token)",
      });
    }
    await this.#store("cloudflared", { token: t, tunnelId: parsed.tunnelId, savedAt: nowIso() });
    await this.reconcileCloudflared();
    return this.cloudflaredStatus();
  }

  async reconcileCloudflared(): Promise<void> {
    const agent = this.hosts.agentFor(LOCAL_HOST_ID);
    const cred = await this.#credential("cloudflared");
    if (!cred) {
      this.#errors.cloudflared = null;
      await agent.setTunnel("cloudflared", null).catch(() => {});
      return;
    }
    if (!this.vault.isUnlocked()) return;
    try {
      const { token } = this.#decrypt("cloudflared", cred.encrypted);
      const binary = await this.#binary("cloudflared");
      await agent.setTunnel("cloudflared", {
        binary,
        args: ["tunnel", "--no-autoupdate", "--metrics", CLOUDFLARED_METRICS, "run"],
        env: { TUNNEL_TOKEN: token },
        statusAddr: CLOUDFLARED_METRICS,
        pidFile: path.join(this.dataDir, "cloudflared", "cloudflared.pid"),
        redact: [token],
      });
      this.#errors.cloudflared = null;
    } catch (err) {
      this.#errors.cloudflared = errMessage(err);
    }
  }

  // --- shared -------------------------------------------------------------------------------

  /** Forget the token and stop the program. */
  async clear(provider: Provider): Promise<void> {
    await this.db
      .delete(schema.credentials)
      .where(eq(schema.credentials.id, credentialId(provider)));
    if (provider === "ngrok") await this.reconcileNgrok();
    else await this.reconcileCloudflared();
  }

  async restart(provider: Provider): Promise<void> {
    await this.hosts
      .agentFor(LOCAL_HOST_ID)
      .setTunnel(provider, null)
      .catch(() => {});
    if (provider === "ngrok") await this.reconcileNgrok();
    else await this.reconcileCloudflared();
  }

  async #tunnel(kind: TunnelKind): Promise<TunnelStatus | null> {
    return this.hosts
      .agentFor(LOCAL_HOST_ID)
      .tunnelStatus(kind)
      .catch(() => null);
  }

  async #credential(provider: Provider) {
    return this.db
      .select()
      .from(schema.credentials)
      .where(eq(schema.credentials.id, credentialId(provider)))
      .get();
  }

  #decrypt(provider: Provider, encrypted: string): Stored {
    return decryptJson<Stored>(this.vault.key(), encrypted, `credential:${credentialId(provider)}`);
  }

  async #store(provider: Provider, value: Stored): Promise<void> {
    if (!this.vault.isUnlocked()) {
      throw new ServerError("BAD_STATE", "Log in again to unlock the credential store");
    }
    const id = credentialId(provider);
    const encrypted = encryptJson(this.vault.key(), value, `credential:${id}`);
    await this.db
      .insert(schema.credentials)
      .values({
        id,
        provider,
        label: provider === "ngrok" ? "ngrok authtoken" : "Cloudflare tunnel token",
        encrypted,
      })
      .onConflictDoUpdate({
        target: schema.credentials.id,
        set: { encrypted, updatedAt: nowIso() },
      });
  }

  // --- programs ---------------------------------------------------------------------------------

  #binary(provider: Provider): Promise<string> {
    let job = this.#jobs.get(provider);
    if (!job) {
      job = (provider === "ngrok" ? this.#installNgrok() : this.#installCloudflared()).finally(() =>
        this.#jobs.delete(provider),
      );
      this.#jobs.set(provider, job);
    }
    return job;
  }

  async #installNgrok(): Promise<string> {
    const current = await this.#binaryInfo("ngrok");
    if (
      current &&
      fs.existsSync(current.path) &&
      Date.now() - Date.parse(current.checkedAt) < UPDATE_CHECK_MS
    ) {
      return current.path;
    }
    const dl = ngrokDownload(process.platform, process.arch);
    if (!dl) throw new Error(`ngrok has no build for ${process.platform}/${process.arch}`);
    const exe = process.platform === "win32" ? "ngrok.exe" : "ngrok";
    const work = path.join(this.dataDir, "tmp", `ngrok-${randomBytes(4).toString("hex")}`);
    try {
      const archive = path.join(work, dl.archive === "zip" ? "ngrok.zip" : "ngrok.tgz");
      try {
        await downloadFile(dl.url, archive);
      } catch (err) {
        if (current && fs.existsSync(current.path)) return current.path;
        throw err;
      }
      const extracted = path.join(work, exe);
      if (dl.archive === "zip") await extractZipEntry(archive, exe, extracted);
      else await run("tar", ["-xzf", archive, "-C", work]);
      if (process.platform === "win32") await verifySignature(extracted, "ngrok, Inc.");
      else await fs.promises.chmod(extracted, 0o755);
      const version =
        /ngrok version ([\d.]+)/.exec(await run(extracted, ["version"]))?.[1] ?? "unknown";
      if (current?.version === version && fs.existsSync(current.path)) {
        await this.#saveBinary("ngrok", { ...current, checkedAt: nowIso() });
        return current.path;
      }
      const dir = path.join(this.dataDir, "ngrok", version);
      await fs.promises.mkdir(dir, { recursive: true });
      const target = path.join(dir, exe);
      await fs.promises.copyFile(extracted, target);
      await this.#saveBinary("ngrok", { version, path: target, checkedAt: nowIso() });
      console.log(`[ngrok] installed ngrok ${version}`);
      return target;
    } finally {
      await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }

  async #installCloudflared(): Promise<string> {
    const current = await this.#binaryInfo("cloudflared");
    if (
      current &&
      fs.existsSync(current.path) &&
      Date.now() - Date.parse(current.checkedAt) < UPDATE_CHECK_MS
    ) {
      return current.path;
    }
    const name = cloudflaredAssetName(process.platform, process.arch);
    if (!name) throw new Error(`cloudflared has no build for ${process.platform}/${process.arch}`);
    let asset: Awaited<ReturnType<typeof latestGithubAsset>>;
    try {
      asset = await latestGithubAsset("cloudflare/cloudflared", name);
    } catch (err) {
      if (current && fs.existsSync(current.path)) return current.path;
      throw err;
    }
    const exe = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
    const dir = path.join(this.dataDir, "cloudflared", asset.version);
    const target = path.join(dir, exe);
    if (!fs.existsSync(target)) {
      if (!asset.sha256) throw new Error("GitHub gave no checksum for the cloudflared download");
      const file = name.endsWith(".tgz") ? path.join(dir, name) : target;
      await downloadFile(asset.url, file, { sha256: asset.sha256 });
      if (name.endsWith(".tgz")) {
        await run("tar", ["-xzf", file, "-C", dir]);
        await fs.promises.rm(file, { force: true });
      }
      if (process.platform !== "win32") await fs.promises.chmod(target, 0o755);
      console.log(`[cloudflared] installed cloudflared ${asset.version}`);
    }
    await this.#saveBinary("cloudflared", {
      version: asset.version,
      path: target,
      checkedAt: nowIso(),
    });
    return target;
  }

  async #binaryInfo(provider: Provider): Promise<BinaryInfo | null> {
    const row = await this.db
      .select({ value: schema.settings.value })
      .from(schema.settings)
      .where(eq(schema.settings.key, `${provider}.binary`))
      .get();
    return row ? (JSON.parse(row.value) as BinaryInfo) : null;
  }

  async #saveBinary(provider: Provider, info: BinaryInfo): Promise<void> {
    const value = JSON.stringify(info);
    await this.db
      .insert(schema.settings)
      .values({ key: `${provider}.binary`, value })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: nowIso() } });
  }
}

function credentialId(provider: Provider): string {
  return `${provider}-local`;
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${file} failed: ${stderr || err.message}`));
      else resolve(`${stdout}${stderr}`);
    });
  });
}

/** Windows only: the binary must carry a valid Authenticode signature from this publisher. */
async function verifySignature(file: string, publisher: string): Promise<void> {
  const out = await run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$s = Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`,
  ]);
  const [status, subject] = out.trim().split("|");
  if (status !== "Valid" || !subject?.includes(publisher)) {
    throw new Error(
      `The downloaded program is not signed by ${publisher} (${status}); not using it.`,
    );
  }
}

function extractZipEntry(zipPath: string, entryName: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) {
        reject(err ?? new Error("cannot open zip"));
        return;
      }
      let found = false;
      zip.on("error", reject);
      zip.on("end", () => {
        if (!found) reject(new Error(`${entryName} not found in the download`));
      });
      zip.on("entry", (entry: yauzl.Entry) => {
        if (entry.fileName !== entryName) {
          zip.readEntry();
          return;
        }
        found = true;
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) {
            reject(e ?? new Error("cannot read zip entry"));
            return;
          }
          const out = fs.createWriteStream(dest);
          stream.pipe(out);
          out.on("finish", () => resolve());
          out.on("error", reject);
        });
      });
      zip.readEntry();
    });
  });
}
