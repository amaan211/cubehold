import type { IncomingMessage } from "node:http";
import net from "node:net";
import path from "node:path";
import { recommendVps } from "@cubehold/shared";
import ssh2, { type Connection } from "ssh2";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { layoutFor } from "./manager.js";
import {
  checkFacts,
  enableFirewallScript,
  envFile,
  nodeArch,
  parseFacts,
  parseSecurity,
  parseUfwAdded,
  syncFirewallScript,
} from "./provision.js";
import { RemoteHostLink } from "./remote-host.js";
import { checkPrivateKey, generateKeyPair, hostKeyOf, SshError, SshSession, shq } from "./ssh.js";

const { Server: SshServer, utils: sshUtils } = ssh2;

const FACTS = `__os
PRETTY_NAME="Ubuntu 24.04.1 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
ID=ubuntu
ID_LIKE=debian
__end
arch=x86_64
kernel=6.8.0-45-generic
hostname=vps-1
systemd=1
apt=1
mem=3814
cpus=2
disk=35120
agent=0
sshports=22 2222
`;

describe("provisioning", () => {
  it("reads system facts and accepts a small Ubuntu VPS with a warning", () => {
    const f = parseFacts(FACTS);
    expect(f).toMatchObject({
      os: "Ubuntu 24.04.1 LTS",
      osId: "ubuntu",
      family: ["ubuntu", "debian"],
      arch: "x86_64",
      systemd: true,
      apt: true,
      memMb: 3814,
      cpus: 2,
      diskFreeMb: 35120,
      sshPorts: [22, 2222],
    });
    expect(checkFacts(f)).toEqual({ problems: [], warnings: [] });
    const small = checkFacts(parseFacts(FACTS.replace("mem=3814", "mem=1900")));
    expect(small.problems).toEqual([]);
    expect(small.warnings[0]).toMatch(/1900 MB/);
  });

  it("refuses other systems, missing systemd, odd CPUs and tiny machines", () => {
    const f = parseFacts(
      FACTS.replace("ID=ubuntu", "ID=rocky")
        .replace("ID_LIKE=debian", 'ID_LIKE="rhel centos fedora"')
        .replace("apt=1", "apt=0")
        .replace("systemd=1", "systemd=0")
        .replace("arch=x86_64", "arch=riscv64")
        .replace("mem=3814", "mem=1024"),
    );
    const { problems } = checkFacts(f);
    expect(problems.join(" ")).toMatch(/not supported yet/);
    expect(problems.join(" ")).toMatch(/systemd/);
    expect(problems.join(" ")).toMatch(/riscv64/);
    expect(problems.join(" ")).toMatch(/1024 MB/);
    expect(nodeArch("aarch64")).toBe("arm64");
    expect(nodeArch("x86_64")).toBe("x64");
  });

  it("keeps the panel's firewall rules in sync without touching others", () => {
    const added = parseUfwAdded(`Added user rules (see 'ufw status' for running firewall):
ufw allow 22/tcp comment 'SSH'
ufw allow 25565/tcp comment 'cubehold Survival'
ufw allow 19132/udp comment 'cubehold Survival Bedrock'
ufw allow 8080/tcp
`);
    expect(added).toHaveLength(4);
    const script = syncFirewallScript(added, [
      { port: 25565, protocol: "tcp", comment: "cubehold Survival" },
      { port: 25566, protocol: "tcp", comment: "cubehold Creative" },
    ]);
    expect(script).toContain("ufw delete allow 19132/udp");
    expect(script).toContain("ufw allow 25566/tcp comment 'cubehold Creative'");
    expect(script).not.toContain("8080");
    expect(script).not.toContain("22/tcp");
    expect(
      syncFirewallScript(
        added,
        added.filter((r) => r.comment?.startsWith("cubehold")),
      ),
    ).toBeNull();
  });

  it("allows SSH and arms the lockout guard before turning ufw on", () => {
    const s = enableFirewallScript(
      [22, 2222],
      [{ port: 25565, protocol: "tcp", comment: "cubehold x" }],
    );
    const at = (t: string) => s.indexOf(t);
    expect(at("ufw allow 22/tcp")).toBeGreaterThan(-1);
    expect(at("ufw allow 2222/tcp")).toBeGreaterThan(-1);
    expect(at("systemd-run")).toBeLessThan(at("ufw --force enable"));
    expect(at("ufw allow 2222/tcp")).toBeLessThan(at("ufw --force enable"));
  });

  it("reads the host's security state", () => {
    const s = parseSecurity(`ufw=Status: active
__rules
ufw allow 22/tcp comment 'SSH'
ufw allow 25565/tcp comment 'cubehold A'
__end
fail2ban=active
autoupdates=1
passwordauthentication yes
kbdinteractiveauthentication no
permitrootlogin without-password
reboot=0`);
    expect(s).toMatchObject({
      firewall: "active",
      fail2ban: "active",
      autoUpdates: true,
      passwordLogin: true,
      rootLogin: "without-password",
      rebootRequired: false,
    });
    expect(s.openPorts).toEqual([{ port: 25565, protocol: "tcp", comment: "cubehold A" }]);
    expect(parseSecurity("ufw=Status: inactive\n__rules\n__end\nfail2ban=missing").firewall).toBe(
      "inactive",
    );
  });

  it("writes the agent settings the daemon reads", () => {
    const env = envFile({ token: "t".repeat(64), port: 47701, build: "abc" });
    expect(env).toMatch(/^CUBEHOLD_AGENT_PORT=47701$/m);
    expect(env).toMatch(/^CUBEHOLD_AGENT_SERVICE=1$/m);
    expect(env).toMatch(/^CUBEHOLD_AGENT_DATA=\/var\/lib\/cubehold$/m);
  });

  it("builds Linux paths even when the panel runs on Windows", () => {
    const l = layoutFor("/var/lib/cubehold", path.posix);
    expect(l.serversDir).toBe("/var/lib/cubehold/servers");
    expect(l.path.join(l.backupsDir, "abc", "versions")).toBe(
      "/var/lib/cubehold/backups/abc/versions",
    );
  });

  it("sizes a VPS for the players and kind of server", () => {
    expect(recommendVps(5, "vanilla")).toEqual({ heapMb: 2048, ramMb: 4096, vcpus: 2 });
    expect(recommendVps(10, "plugins").ramMb).toBe(8192);
    expect(recommendVps(30, "modpack")).toMatchObject({ heapMb: 9216, ramMb: 12288, vcpus: 8 });
  });
});

describe("ssh helpers", () => {
  it("quotes for the shell", () => {
    expect(shq("it's")).toBe(`'it'\\''s'`);
  });

  it("generates keys the parser accepts, and explains bad input", () => {
    const pair = generateKeyPair("cubehold-panel-test");
    expect(pair.publicKey).toMatch(/^ssh-ed25519 \S+ cubehold-panel-test$/);
    expect(checkPrivateKey(pair.privateKey).type).toBe("ssh-ed25519");
    expect(() => checkPrivateKey(pair.publicKey)).toThrow(/public key/);
    expect(() => checkPrivateKey("hello")).toThrow(SshError);
  });
});

// --- against a real SSH server (ssh2's server, in process) -----------------------------

interface FakeHost {
  port: number;
  fingerprint: string;
  close: () => Promise<void>;
  /** Drop every client connection, like a network blip. */
  drop: () => void;
  execs: string[];
}

function fakeSshHost(opts: {
  password: string;
  publicKey: string;
  port?: number;
}): Promise<FakeHost> {
  const hostKey = sshUtils.generateKeyPairSync("ed25519");
  const hostParsed = sshUtils.parseKey(hostKey.private);
  if (hostParsed instanceof Error) throw hostParsed;
  const allowed = sshUtils.parseKey(opts.publicKey);
  if (allowed instanceof Error) throw allowed;
  const clients = new Set<Connection>();
  const execs: string[] = [];
  const server = new SshServer({ hostKeys: [hostKey.private] }, (client) => {
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.password === opts.password) return ctx.accept();
      if (ctx.method === "publickey" && ctx.key.data.equals(allowed.getPublicSSH())) {
        if (!ctx.signature || !ctx.blob) return ctx.accept();
        return allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) ? ctx.accept() : ctx.reject();
      }
      ctx.reject(["password", "publickey"]);
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _reject, info) => {
          execs.push(info.command);
          const stream = acceptExec();
          stream.write(`ran ${info.command}\n`);
          stream.exit(0);
          stream.end();
        });
      });
      client.on("tcpip", (accept, reject, info) => {
        const sock = net.connect(info.destPort, info.destIP);
        sock.once("connect", () => {
          const ch = accept();
          sock.pipe(ch).pipe(sock);
          ch.on("close", () => sock.destroy());
          sock.on("close", () => ch.close());
        });
        sock.once("error", () => reject());
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        port: addr.port,
        fingerprint: hostKeyOf(hostParsed.getPublicSSH()).fingerprint,
        execs,
        drop: () => {
          for (const c of clients) c.end();
        },
        close: () =>
          new Promise<void>((r) => {
            for (const c of clients) c.end();
            server.close(() => r());
          }),
      });
    });
  });
}

/** A stand-in for the agent daemon: says hello and answers hostInfo. */
function fakeAgent(token: string): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      verifyClient: ({ req }: { req: IncomingMessage }) =>
        req.headers.authorization === `Bearer ${token}`,
    });
    wss.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "hello", build: "fake", pid: 1, startedAt: "", running: [] }));
      ws.on("message", (raw) => {
        const req = JSON.parse(raw.toString()) as { id: number; method: string };
        ws.send(
          JSON.stringify({
            type: "res",
            id: req.id,
            ok: true,
            result: { hostname: "fake-vps", method: req.method },
          }),
        );
      });
    });
    wss.on("listening", () => {
      const addr = wss.address() as net.AddressInfo;
      resolve({
        port: addr.port,
        close: () => {
          for (const c of wss.clients) c.terminate();
          wss.close();
        },
      });
    });
  });
}

async function until(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("SSH sessions and host links", () => {
  const cleanup: Array<() => unknown> = [];
  afterEach(async () => {
    for (const c of cleanup.splice(0).reverse()) await c();
  });

  it("logs in, pins the host key and runs commands", async () => {
    const panel = generateKeyPair("cubehold-panel-t1");
    const host = await fakeSshHost({ password: "pw", publicKey: panel.publicKey });
    cleanup.push(host.close);
    const target = { host: "127.0.0.1", port: host.port, username: "root" };

    const s = await SshSession.connect(target, { password: "pw" });
    expect(s.hostKey.fingerprint).toBe(host.fingerprint);
    expect(s.hostKey.type).toBe("ssh-ed25519");
    const r = await s.exec("echo hi");
    expect(r).toMatchObject({ code: 0, stdout: "ran echo hi\n" });
    s.close();

    const wrongKey = await SshSession.connect(
      target,
      { password: "pw" },
      {
        expectFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    ).catch((e: SshError) => e);
    expect(wrongKey).toBeInstanceOf(SshError);
    expect((wrongKey as SshError).code).toBe("hostkey");

    const badPassword = await SshSession.connect(target, { password: "nope" }).catch(
      (e: SshError) => e,
    );
    expect((badPassword as SshError).code).toBe("auth");

    const withKey = await SshSession.connect(
      target,
      { privateKey: panel.privateKey },
      { expectFingerprint: host.fingerprint },
    );
    withKey.close();
  });

  it("reaches the agent through the tunnel and reconnects after a drop", async () => {
    const panel = generateKeyPair("cubehold-panel-t2");
    const token = "k".repeat(64);
    const agent = await fakeAgent(token);
    cleanup.push(agent.close);
    const host = await fakeSshHost({ password: "pw", publicKey: panel.publicKey });
    cleanup.push(host.close);

    const states: string[] = [];
    const link = new RemoteHostLink({
      hostId: "h1",
      name: "Test VPS",
      target: { host: "127.0.0.1", port: host.port, username: "root" },
      fingerprint: host.fingerprint,
      agentPort: agent.port,
      secret: async () => ({
        privateKey: panel.privateKey,
        publicKey: panel.publicKey,
        agentToken: token,
        sudoPassword: null,
      }),
      log: () => {},
    });
    link.onStatus((s) => states.push(s.state));
    cleanup.push(() => link.stop());
    await link.start();
    await until(() => link.status.state === "online", 10_000);
    expect(await link.agent.hostInfo()).toMatchObject({ hostname: "fake-vps" });

    host.drop();
    await until(() => link.status.state === "offline", 10_000);
    await expect(link.agent.hostInfo()).rejects.toThrow(/Test VPS is offline/);
    await until(() => link.status.state === "online", 20_000);
    expect(await link.agent.hostInfo()).toMatchObject({ hostname: "fake-vps" });
    expect(states.slice(0, 3)).toEqual(["online", "offline", "online"]);
  }, 40_000);

  it("stops retrying when the host key changes", async () => {
    const panel = generateKeyPair("cubehold-panel-t3");
    const host = await fakeSshHost({ password: "pw", publicKey: panel.publicKey });
    cleanup.push(host.close);
    const link = new RemoteHostLink({
      hostId: "h2",
      name: "Reinstalled VPS",
      target: { host: "127.0.0.1", port: host.port, username: "root" },
      fingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      agentPort: 1,
      secret: async () => ({
        privateKey: panel.privateKey,
        publicKey: panel.publicKey,
        agentToken: "x".repeat(64),
        sudoPassword: null,
      }),
      log: () => {},
    });
    cleanup.push(() => link.stop());
    await link.start();
    await until(() => link.status.state === "error", 10_000);
    expect(link.status.error).toMatch(/identity changed/);
  });
});
