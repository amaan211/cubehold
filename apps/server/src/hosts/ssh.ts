import { createHash } from "node:crypto";
import net from "node:net";
import ssh2, { type ClientChannel } from "ssh2";

// ssh2 is CommonJS: Node's ESM loader only sees its default export.
const { Client: SshClient, utils: sshUtils } = ssh2;
type SshClient = InstanceType<typeof SshClient>;

export interface SshTarget {
  host: string;
  port: number;
  username: string;
}

/** One of these is enough; a key wins when both are given. */
export interface SshAuth {
  privateKey?: string;
  passphrase?: string;
  password?: string;
}

export interface HostKey {
  /** "ssh-ed25519", "ecdsa-sha2-nistp256", ... */
  type: string;
  /** "SHA256:..." exactly as `ssh-keygen -lf` prints it. */
  fingerprint: string;
}

export type SshErrorCode =
  | "auth"
  | "hostkey"
  | "network"
  | "timeout"
  | "forwarding"
  | "sudo"
  | "command";

export class SshError extends Error {
  constructor(
    readonly code: SshErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** How this login gets root: it is root, sudo without a password, or sudo with one. */
export type RootAccess = "root" | "sudo" | "sudo-password" | "none";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  stdin?: string | Buffer;
  timeoutMs?: number;
  /** Each output line as it arrives. */
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
}

const MAX_OUTPUT = 256 * 1024;

export function hostKeyOf(blob: Buffer): HostKey {
  const len = blob.length >= 4 ? blob.readUInt32BE(0) : 0;
  const type = len > 0 && len < 64 ? blob.subarray(4, 4 + len).toString("ascii") : "unknown";
  const digest = createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
  return { type, fingerprint: `SHA256:${digest}` };
}

/** A fresh ed25519 key pair in OpenSSH format. */
export function generateKeyPair(comment: string): { privateKey: string; publicKey: string } {
  const pair = sshUtils.generateKeyPairSync("ed25519", { comment });
  return { privateKey: pair.private, publicKey: pair.public.trim() };
}

/** Parse a pasted private key; throws a readable error for bad input or a wrong passphrase. */
export function checkPrivateKey(privateKey: string, passphrase?: string): { type: string } {
  const parsed = sshUtils.parseKey(privateKey.trim(), passphrase || undefined);
  if (parsed instanceof Error) {
    const msg = parsed.message.toLowerCase();
    if (msg.includes("passphrase") || msg.includes("encrypted")) {
      throw new SshError(
        "auth",
        passphrase ? "The passphrase does not unlock this key" : "This key needs its passphrase",
      );
    }
    throw new SshError("auth", `This is not a private key the panel can read (${parsed.message})`);
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key?.isPrivateKey())
    throw new SshError("auth", "That is a public key; paste the private one");
  return { type: key.type };
}

/** Quote for a POSIX shell. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * An authenticated SSH connection: commands, root scripts and file writes,
 * and tunnels to ports on the host's loopback.
 */
export class SshSession {
  #closed = false;
  #closeListeners = new Set<(err: Error | null) => void>();
  root: RootAccess = "none";
  #sudoPassword: string | null = null;

  private constructor(
    private readonly client: SshClient,
    readonly target: SshTarget,
    readonly hostKey: HostKey,
  ) {
    client.on("close", () => this.#onClose(null));
    client.on("error", (err) => this.#onClose(err));
  }

  /**
   * Connect and log in. With `expectFingerprint`, a different host key fails
   * the connection before any credential is sent.
   */
  static connect(
    target: SshTarget,
    auth: SshAuth,
    opts: { expectFingerprint?: string | null; readyTimeoutMs?: number } = {},
  ): Promise<SshSession> {
    return new Promise((resolve, reject) => {
      const client = new SshClient();
      let hostKey: HostKey | null = null;
      let hostKeyRejected = false;
      let settled = false;
      const fail = (err: SshError) => {
        if (settled) return;
        settled = true;
        client.removeAllListeners();
        client.on("error", () => {});
        client.end();
        reject(err);
      };
      client.once("ready", () => {
        if (settled || !hostKey) return;
        settled = true;
        client.removeAllListeners("error");
        client.removeAllListeners("close");
        resolve(new SshSession(client, target, hostKey));
      });
      client.once("close", () =>
        fail(new SshError("network", `${target.host} closed the connection during login.`)),
      );
      client.on("error", (err: Error & { level?: string; code?: string }) => {
        if (hostKeyRejected) {
          return fail(
            new SshError(
              "hostkey",
              `The server's identity changed: it now shows ${hostKey?.fingerprint ?? "another key"}. If you reinstalled the server this is expected; otherwise someone may be intercepting the connection.`,
            ),
          );
        }
        if (err.level === "client-authentication") {
          return fail(
            new SshError(
              "auth",
              `The server refused the login for ${target.username}. Check the user name and the password or key.`,
            ),
          );
        }
        if (err.level === "client-timeout" || err.code === "ETIMEDOUT") {
          return fail(
            new SshError(
              "timeout",
              `No answer from ${target.host}:${target.port}. Check the address, and that the provider's firewall allows SSH.`,
            ),
          );
        }
        if (err.code === "ECONNREFUSED") {
          return fail(
            new SshError(
              "network",
              `${target.host} refused the connection on port ${target.port}: SSH is not running there, or it uses another port.`,
            ),
          );
        }
        if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") {
          return fail(new SshError("network", `Could not find ${target.host}: check the address.`));
        }
        if (err.code === "EHOSTUNREACH" || err.code === "ENETUNREACH") {
          return fail(new SshError("network", `${target.host} cannot be reached from here.`));
        }
        fail(new SshError("network", `SSH to ${target.host} failed: ${err.message}`));
      });
      client.on("keyboard-interactive", (_name, _instr, _lang, prompts, finish) => {
        finish(prompts.map(() => auth.password ?? ""));
      });
      client.connect({
        host: target.host,
        port: target.port,
        username: target.username,
        privateKey: auth.privateKey,
        passphrase: auth.passphrase || undefined,
        password: auth.privateKey ? undefined : auth.password,
        tryKeyboard: !auth.privateKey && !!auth.password,
        readyTimeout: opts.readyTimeoutMs ?? 20_000,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 4,
        hostVerifier: (key: Buffer) => {
          hostKey = hostKeyOf(key);
          if (opts.expectFingerprint && hostKey.fingerprint !== opts.expectFingerprint) {
            hostKeyRejected = true;
            return false;
          }
          return true;
        },
      });
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  onClose(listener: (err: Error | null) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  close(): void {
    this.client.end();
    this.#onClose(null);
  }

  /** Run a command as the login user. */
  exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      if (this.#closed) return reject(new SshError("network", "The SSH connection is closed"));
      this.client.exec(command, (err, stream) => {
        if (err) return reject(new SshError("command", `Could not run a command: ${err.message}`));
        let stdout = "";
        let stderr = "";
        const partial = { stdout: "", stderr: "" };
        const take = (which: "stdout" | "stderr", chunk: Buffer) => {
          const text = chunk.toString("utf8");
          if (which === "stdout") stdout = (stdout + text).slice(-MAX_OUTPUT);
          else stderr = (stderr + text).slice(-MAX_OUTPUT);
          if (!opts.onLine) return;
          const lines = (partial[which] + text).split(/\r?\n/);
          partial[which] = lines.pop() ?? "";
          for (const l of lines) opts.onLine(l, which);
        };
        const timer = opts.timeoutMs
          ? setTimeout(() => {
              stream.close();
              reject(new SshError("timeout", `A command took longer than ${opts.timeoutMs} ms`));
            }, opts.timeoutMs)
          : null;
        stream.on("data", (c: Buffer) => take("stdout", c));
        stream.stderr.on("data", (c: Buffer) => take("stderr", c));
        stream.on("close", (code: number | null) => {
          if (timer) clearTimeout(timer);
          if (opts.onLine) {
            if (partial.stdout) opts.onLine(partial.stdout, "stdout");
            if (partial.stderr) opts.onLine(partial.stderr, "stderr");
          }
          resolve({ code: code ?? null, stdout, stderr });
        });
        if (opts.stdin !== undefined) stream.end(opts.stdin);
        else stream.end();
      });
    });
  }

  /**
   * Find out how this login becomes root. "sudo-password" without a
   * password given means sudo would work once the password is known.
   */
  async detectRoot(sudoPassword?: string | null): Promise<RootAccess> {
    const id = await this.exec("id -u");
    if (id.stdout.trim() === "0") return this.useRoot("root", null);
    const hasSudo = await this.exec("command -v sudo");
    if (hasSudo.code !== 0) return this.useRoot("none", null);
    const nopass = await this.exec("sudo -n true");
    if (nopass.code === 0) return this.useRoot("sudo", null);
    if (!/password/i.test(nopass.stderr)) return this.useRoot("none", null);
    if (!sudoPassword) return this.useRoot("sudo-password", null);
    const withPass = await this.exec("sudo -S -p '' true", { stdin: `${sudoPassword}\n` });
    if (withPass.code === 0) return this.useRoot("sudo-password", sudoPassword);
    throw new SshError("sudo", `sudo did not accept the password for ${this.target.username}`);
  }

  /** Use a root method found earlier (by detectRoot on another session). */
  useRoot(root: RootAccess, password: string | null): RootAccess {
    this.root = root;
    this.#sudoPassword = password;
    return root;
  }

  /**
   * Run a shell script as root. The script travels on stdin into a private
   * temp file, so secrets in it never show up in a process list.
   */
  async runAsRoot(script: string, opts: Omit<ExecOptions, "stdin"> = {}): Promise<ExecResult> {
    const runner = `f=$(mktemp) && cat > "$f" && bash "$f" </dev/null; c=$?; rm -f "$f"; exit $c`;
    return this.exec(this.#rootCommand(runner), {
      ...opts,
      stdin: this.#withPassword(Buffer.from(script, "utf8")),
    });
  }

  /** Write a file as root, atomically, with the given mode and owner. */
  async writeFileAsRoot(
    file: string,
    content: string | Buffer,
    opts: { mode?: string; owner?: string } = {},
  ): Promise<void> {
    const mode = opts.mode ?? "644";
    const owner = opts.owner ?? "root:root";
    const inner = `umask 077 && cat > "$0.cubehold-tmp" && chmod ${mode} "$0.cubehold-tmp" && chown ${owner} "$0.cubehold-tmp" && mv -f "$0.cubehold-tmp" "$0"`;
    const res = await this.exec(`${this.#rootCommand(inner)} ${shq(file)}`, {
      stdin: this.#withPassword(typeof content === "string" ? Buffer.from(content) : content),
      timeoutMs: 5 * 60_000,
    });
    if (res.code !== 0) {
      throw new SshError("command", `Could not write ${file}: ${res.stderr.trim() || res.code}`);
    }
  }

  #rootCommand(inner: string): string {
    switch (this.root) {
      case "root":
        return `sh -c ${shq(inner)}`;
      case "sudo":
        return `sudo -n sh -c ${shq(inner)}`;
      case "sudo-password":
        if (!this.#sudoPassword) {
          throw new SshError("sudo", `sudo needs the password of ${this.target.username}`);
        }
        return `sudo -S -p '' sh -c ${shq(inner)}`;
      default:
        throw new SshError("sudo", `${this.target.username} cannot become root (no sudo rights)`);
    }
  }

  #withPassword(data: Buffer): Buffer {
    return this.root === "sudo-password" && this.#sudoPassword
      ? Buffer.concat([Buffer.from(`${this.#sudoPassword}\n`), data])
      : data;
  }

  /** A TCP stream to host:port as seen from the server (loopback ports included). */
  forwardOut(host: string, port: number): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      if (this.#closed) return reject(new SshError("network", "The SSH connection is closed"));
      this.client.forwardOut("127.0.0.1", 0, host, port, (err, stream) => {
        if (!err) return resolve(stream);
        const prohibited = /prohibited/i.test(err.message);
        reject(
          new SshError(
            prohibited ? "forwarding" : "network",
            prohibited
              ? "The SSH server does not allow port forwarding (AllowTcpForwarding is off in sshd_config)."
              : `Could not reach port ${port} on the server: ${err.message}`,
          ),
        );
      });
    });
  }

  #onClose(err: Error | null): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const l of this.#closeListeners) l(err);
    this.#closeListeners.clear();
  }
}

/**
 * A listener on 127.0.0.1 that carries each connection through the current
 * SSH session to a port on the remote host. It survives SSH reconnects, so
 * the agent client can keep one fixed URL.
 */
export class LocalForward {
  #server: net.Server | null = null;
  #sockets = new Set<net.Socket>();
  port = 0;

  constructor(
    private readonly session: () => SshSession | null,
    private readonly remotePort: number,
  ) {}

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((sock) => void this.#pipe(sock));
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        this.port = typeof addr === "object" && addr ? addr.port : 0;
        this.#server = server;
        resolve(this.port);
      });
    });
  }

  async #pipe(sock: net.Socket): Promise<void> {
    this.#sockets.add(sock);
    sock.once("close", () => this.#sockets.delete(sock));
    sock.on("error", () => {});
    const session = this.session();
    if (!session || session.closed) {
      sock.destroy();
      return;
    }
    let channel: ClientChannel;
    try {
      channel = await session.forwardOut("127.0.0.1", this.remotePort);
    } catch {
      sock.destroy();
      return;
    }
    if (sock.destroyed) {
      channel.close();
      return;
    }
    channel.on("error", () => sock.destroy());
    channel.on("close", () => sock.destroy());
    sock.on("close", () => channel.close());
    sock.pipe(channel).pipe(sock);
  }

  /** Drop every open tunnel connection, e.g. when the SSH session went away. */
  dropAll(): void {
    for (const s of this.#sockets) s.destroy();
  }

  close(): void {
    this.dropAll();
    this.#server?.close();
    this.#server = null;
  }
}
