import { log4jMitigation } from "@cubehold/mc";
import {
  type CheckSeverity,
  LOCAL_HOST_ID,
  type SecurityCheck,
  type Server,
  securityGrade,
  securityScore,
} from "@cubehold/shared";
import { isLoopback } from "@cubehold/tunnels";
import type { Config } from "../config.js";
import type { HostService } from "../hosts/service.js";
import type { NetworkService } from "../network/service.js";
import type { AddonService } from "../servers/addons.js";
import type { PlayerService } from "../servers/players.js";
import { errMessage, ServerError, type ServerRow, type ServerService } from "../servers/service.js";

const REPORT_TTL_MS = 15_000;

/** Plugins and mods worth having on a public server, per loader. */
const BUNDLE = {
  plugin: [
    {
      id: "coreprotect",
      name: "CoreProtect",
      description:
        "Logs every block change and chest access, so griefing can be looked up and undone.",
      recommended: true,
    },
    {
      id: "luckperms",
      name: "LuckPerms",
      description: "Give players exactly the commands they need instead of full operator rights.",
      recommended: true,
    },
    {
      id: "griefprevention",
      name: "GriefPrevention",
      description:
        "Players claim land with a golden shovel; others cannot build or open chests there.",
      recommended: false,
    },
  ],
  mod: [
    {
      id: "ledger",
      name: "Ledger",
      description: "Logs block changes and container use, with rollback: CoreProtect for Fabric.",
      recommended: true,
    },
    {
      id: "luckperms",
      name: "LuckPerms",
      description: "Give players exactly the commands they need instead of full operator rights.",
      recommended: true,
    },
  ],
} as const;

const FILE_PATTERNS: Record<string, RegExp> = {
  coreprotect: /coreprotect/i,
  luckperms: /luckperms/i,
  griefprevention: /griefprevention/i,
  ledger: /ledger/i,
};

/**
 * Security report for one server: each check says what is the case, why it
 * matters and, where the panel can, offers a fix. Severity depends on
 * exposure: offline mode on a server only your household can reach is a
 * footnote; on one the internet can reach it is the worst problem there is.
 */
export class SecurityService {
  #cache = new Map<string, { at: number; report: Awaited<ReturnType<SecurityService["build"]>> }>();
  /** Last known score per server, kept after the report cache expires (for the checklist). */
  #scores = new Map<string, number>();

  constructor(
    private readonly servers: ServerService,
    private readonly players: PlayerService,
    private readonly addons: AddonService,
    private readonly network: NetworkService,
    private readonly hostAdmin: HostService,
    private readonly config: Config,
  ) {}

  /** The score of the last report built for a server, without building one (cheap). */
  lastScore(serverId: string): number | null {
    return this.#scores.get(serverId) ?? null;
  }

  async report(serverId: string, fresh = false) {
    const hit = this.#cache.get(serverId);
    if (!fresh && hit && Date.now() - hit.at < REPORT_TTL_MS) return hit.report;
    const report = await this.build(serverId);
    this.#cache.set(serverId, { at: Date.now(), report });
    this.#scores.set(serverId, report.score);
    return report;
  }

  async build(serverId: string) {
    const row = await this.servers.row(serverId);
    const software = row.software as Server["software"];
    const agent = this.servers.agentOf(row);
    const [props, exposure, firewall, hostSec, files, spigot, paperGlobal, ops] = await Promise.all(
      [
        this.servers.getProperties(serverId),
        this.network.exposure(serverId).catch(() => ({ internet: false, via: [] as string[] })),
        this.network.firewall(row).catch(() => null),
        this.network.hostSecurity(row).catch(() => null),
        this.#addonFiles(row),
        agent.readFile(row.directory, "spigot.yml").catch(() => null),
        agent.readFile(row.directory, "config/paper-global.yml").catch(() => null),
        agent
          .readFile(row.directory, "ops.json")
          .then((t) => JSON.parse(t) as Array<{ name: string }>)
          .catch(() => [] as Array<{ name: string }>),
      ],
    );
    const v = props.values;
    const exposed = exposure.internet;
    const viaText = exposure.via
      .map(
        (x) =>
          ({
            upnp: "router port forwarding",
            playit: "playit.gg",
            ngrok: "ngrok",
            cloudflare: "Cloudflare Tunnel",
            funnel: "Tailscale Funnel",
            tested: "a successful outside test",
            vps: "the VPS's public address",
          })[x] ?? x,
      )
      .join(", ");
    const checks: SecurityCheck[] = [];
    const add = (
      c: Omit<SecurityCheck, "fix" | "detail"> & Partial<Pick<SecurityCheck, "fix" | "detail">>,
    ) => checks.push({ detail: null, fix: null, ...c });
    const scaled = (internet: CheckSeverity, lan: CheckSeverity) => (exposed ? internet : lan);

    // 1. Accounts
    if (v["online-mode"] === false) {
      add({
        id: "online-mode",
        title: "Player accounts are verified",
        status: "fail",
        severity: scaled("critical", "medium"),
        summary: "Offline mode: anyone can join under any name, including yours or an operator's.",
        detail: exposed
          ? `The server is reachable from the internet (${viaText}). With offline mode anyone can take over an operator's name and run commands.`
          : "Only people who can reach your network can join right now, but it becomes serious as soon as the server is shared.",
        fix: { label: "Turn on player login", kind: "auto", restart: true },
      });
    } else {
      add({
        id: "online-mode",
        title: "Player accounts are verified",
        status: "pass",
        severity: "critical",
        summary: "Players must sign in with a Microsoft account; names cannot be faked.",
      });
    }

    // 2. Whitelist
    const whitelistCount = await agent
      .readFile(row.directory, "whitelist.json")
      .then((t) => (JSON.parse(t) as unknown[]).length)
      .catch(() => 0);
    if (v["white-list"] === true) {
      add({
        id: "whitelist",
        title: "Only invited players can join",
        status: "pass",
        severity: "medium",
        summary: `The whitelist is on with ${whitelistCount} player${whitelistCount === 1 ? "" : "s"}.`,
        detail:
          v["enforce-whitelist"] === true
            ? null
            : "Tip: enforce-whitelist also kicks players you remove while they are online.",
      });
    } else {
      add({
        id: "whitelist",
        title: "Only invited players can join",
        status: exposed ? "fail" : "info",
        severity: "medium",
        summary: exposed
          ? "The whitelist is off: anyone who finds the address can join."
          : "The whitelist is off. Fine while only your network can reach the server.",
        detail: "Turning it on adds everyone who has played here, so nobody is locked out.",
        fix: { label: "Turn on the whitelist", kind: "auto", restart: false },
      });
    }

    // 3. Proxy forwarding (player data trusted from a proxy)
    if (software === "paper" || software === "purpur") {
      const bungee = spigot ? /^\s*bungeecord:\s*true\s*$/m.test(spigot) : false;
      const velocity = paperGlobal
        ? /velocity:\s*\r?\n(?:\s+.*\r?\n)*?\s+enabled:\s*true/.test(paperGlobal)
        : false;
      if (bungee) {
        add({
          id: "proxy-forwarding",
          title: "Player data cannot be faked",
          status: "fail",
          severity: scaled("critical", "high"),
          summary: "BungeeCord mode is on: the server trusts whoever connects to say who they are.",
          detail:
            "Without a BungeeCord proxy in front (and the server hidden behind it), anyone can join as any player, operators included.",
          fix: { label: "Turn off BungeeCord mode", kind: "auto", restart: true },
        });
      } else if (velocity) {
        add({
          id: "proxy-forwarding",
          title: "Player data cannot be faked",
          status: "warn",
          severity: "medium",
          summary: "Velocity forwarding is on in paper-global.yml.",
          detail:
            "That is safe only if players reach this server through your Velocity proxy with a secret set.",
        });
      } else {
        add({
          id: "proxy-forwarding",
          title: "Player data cannot be faked",
          status: "pass",
          severity: "critical",
          summary: spigot
            ? "No proxy forwarding: players connect directly and are checked."
            : "Not configured yet; the defaults are safe.",
        });
      }
    }

    // 4. Windows Firewall and RCON
    const rconPort = row.settings?.rcon?.port ?? null;
    if (firewall?.supported) {
      const net = firewall.network
        ? ` Windows treats "${firewall.network.name}" as a ${firewall.network.category.toLowerCase()} network.`
        : "";
      if (firewall.blocked || (firewall.game && !firewall.game.allowed)) {
        add({
          id: "firewall",
          title: "Windows Firewall",
          status: "fail",
          severity: "low",
          summary: firewall.blocked
            ? "Windows Firewall blocks Java (the Windows prompt was probably cancelled once)."
            : `Windows Firewall does not let connections reach port ${row.port}.`,
          detail: `Players on your network, or coming in through port forwarding, cannot connect. playit.gg still works.${net}`,
          fix: { label: "Allow the game port", kind: "admin", restart: false },
        });
      } else if (firewall.programWide) {
        add({
          id: "firewall",
          title: "Windows Firewall",
          status: "warn",
          severity: "low",
          summary: "Java may accept connections on any port, not just the game port.",
          detail: `Windows created this rule when Java first asked. It also opens RCON${rconPort ? ` (${rconPort})` : ""} and anything a plugin starts, like web maps.${net}`,
          fix: { label: "Allow game ports only", kind: "admin", restart: false },
        });
      } else {
        add({
          id: "firewall",
          title: "Windows Firewall",
          status: "pass",
          severity: "low",
          summary: `Java is allowed on its game port${firewall.bedrock ? "s" : ""} only.${net}`,
        });
      }
    }
    // 4b. The VPS itself: its firewall, SSH logins, fail2ban and updates.
    const hs = hostSec?.security ?? null;
    if (hs) {
      const on = hs.firewall === "active";
      add({
        id: "host-firewall",
        title: "Host firewall",
        status: on ? "pass" : "fail",
        severity: "medium",
        summary: on
          ? "The firewall (ufw) lets in SSH and this server's game ports only."
          : hs.firewall === "missing"
            ? "The host has no firewall: every program that listens can be reached from the internet, RCON included."
            : "The host firewall (ufw) is off: every program that listens can be reached from the internet, RCON included.",
        fix: on ? null : { label: "Turn on the firewall", kind: "host", restart: false },
      });
      add({
        id: "ssh-passwords",
        title: "SSH accepts keys only",
        status: hs.passwordLogin ? "warn" : "pass",
        severity: "low",
        summary: hs.passwordLogin
          ? "SSH still accepts passwords. Bots try passwords on every public server all day."
          : "SSH only accepts keys, so password guessing cannot work.",
        detail: hs.passwordLogin
          ? "After this you log in with an SSH key (the panel already uses one). Your provider's web console keeps working."
          : null,
        fix: hs.passwordLogin ? { label: "Keys only", kind: "host", restart: false } : null,
      });
      add({
        id: "fail2ban",
        title: "Repeated failed logins are blocked",
        status: hs.fail2ban === "active" ? "pass" : "warn",
        severity: "low",
        summary:
          hs.fail2ban === "active"
            ? "fail2ban blocks addresses that keep failing to log in over SSH."
            : "fail2ban is not running, so nothing slows down password guessing.",
        fix:
          hs.fail2ban === "active"
            ? null
            : { label: "Turn on fail2ban", kind: "host", restart: false },
      });
      add({
        id: "auto-updates",
        title: "Automatic security updates",
        status: hs.autoUpdates ? "pass" : "warn",
        severity: "low",
        summary: hs.autoUpdates
          ? `Security updates install by themselves every day.${hs.rebootRequired ? " Some need a restart of the VPS to take effect." : ""}`
          : "Security updates are not installed automatically.",
        fix: hs.autoUpdates ? null : { label: "Turn on", kind: "host", restart: false },
      });
    }
    const rconExposed = firewall?.rcon?.allowed || (hs !== null && hs.firewall !== "active");
    add({
      id: "rcon",
      title: "Remote console is private",
      status: rconExposed ? "warn" : "pass",
      severity: "low",
      summary: rconPort
        ? `RCON listens on port ${rconPort} with a random 64-character password only the panel knows.`
        : "RCON gets a random 64-character password the first time the server starts.",
      detail: hs
        ? hs.firewall === "active"
          ? "The host firewall keeps the RCON port closed to the internet."
          : "Without a host firewall the RCON port is open to the internet; only its long password protects it."
        : firewall?.rcon?.allowed
          ? "Devices on your network can reach that port. Never forward it on your router."
          : "Never forward the RCON port on your router.",
      fix: hs
        ? hs.firewall === "active"
          ? null
          : { label: "Turn on the firewall", kind: "host", restart: false }
        : firewall?.rcon?.allowed
          ? { label: "Allow game ports only", kind: "admin", restart: false }
          : null,
    });

    // 5. Query
    if (v["enable-query"] === true) {
      add({
        id: "query",
        title: "Server query is off",
        status: "warn",
        severity: "low",
        summary: "Query is on: anyone who can reach the server can list its players and plugins.",
        fix: { label: "Turn off query", kind: "auto", restart: true },
      });
    } else {
      add({
        id: "query",
        title: "Server query is off",
        status: "pass",
        severity: "low",
        summary: "The query protocol is off; the server list shows only what players see.",
      });
    }

    // 6. Log4Shell
    const log4j = log4jMitigation(software, row.mcVersion);
    add({
      id: "log4shell",
      title: "Log4Shell (CVE-2021-44228)",
      status: "pass",
      severity: "critical",
      summary: {
        "not-affected": `Minecraft ${row.mcVersion} is not affected.`,
        "fixed-build": `${software === "paper" ? "Paper" : "Purpur"} builds for ${row.mcVersion} include the fixed log4j.`,
        flag: "Protected: the panel starts Java with -Dlog4j2.formatMsgNoLookups=true.",
        "config-file": `Protected: the panel applies Mojang's fix (${log4j.file?.name}) at every start.`,
      }[log4j.status],
    });

    // 7. Version age
    const minor = /^1\.(\d+)/.exec(row.mcVersion);
    const old = minor ? Number(minor[1]) < 18 : false;
    add({
      id: "version",
      title: "Minecraft version still gets fixes",
      status: old ? "warn" : "pass",
      severity: "medium",
      summary: old
        ? `Minecraft ${row.mcVersion} no longer gets fixes, and crash and lag exploits for it are public.`
        : `Minecraft ${row.mcVersion} is recent.`,
      detail: old
        ? "Change the version in Settings if your players can move to a newer one."
        : null,
    });

    // 8. Block logging
    const kind = software === "fabric" ? "mod" : software === "vanilla" ? null : "plugin";
    const logger = kind === "mod" ? "ledger" : "coreprotect";
    if (kind) {
      const has = files.some((f) => FILE_PATTERNS[logger]?.test(f));
      add({
        id: "grief-log",
        title: "Griefing can be undone",
        status: has ? "pass" : exposed ? "warn" : "info",
        severity: "low",
        summary: has
          ? `${logger === "ledger" ? "Ledger" : "CoreProtect"} logs block changes; you can look up and roll back griefing.`
          : "Nothing records who broke or took what, so griefing cannot be traced or undone.",
        fix: has
          ? null
          : {
              label: `Install ${logger === "ledger" ? "Ledger" : "CoreProtect"}`,
              kind: "auto",
              restart: true,
            },
      });
    }

    // 9. Panel
    const panelLocal = isLoopback(this.config.HOST);
    add({
      id: "panel",
      title: "Panel access",
      status: panelLocal || this.config.SECURE_COOKIES ? "pass" : "warn",
      severity: "high",
      summary: panelLocal
        ? "Only this computer can open the panel."
        : this.config.SECURE_COOKIES
          ? "The panel is reachable from the network over HTTPS."
          : "The panel is reachable from other devices over plain HTTP; logins cross the network unencrypted.",
      detail:
        panelLocal || this.config.SECURE_COOKIES
          ? null
          : "Set HOST=127.0.0.1, or put it behind HTTPS and set SECURE_COOKIES=true.",
    });

    // 10. Operators (information only)
    add({
      id: "ops",
      title: "Operators",
      status: "info",
      severity: "low",
      summary:
        ops.length === 0
          ? "Nobody has operator rights."
          : `${ops.length} operator${ops.length === 1 ? "" : "s"} with full control: ${ops
              .slice(0, 5)
              .map((o) => o.name)
              .join(", ")}${ops.length > 5 ? "…" : ""}.`,
      detail: ops.length > 0 ? "Operators can run any command, including /stop and /op." : null,
    });

    const score = securityScore(checks);
    const bundle = kind
      ? BUNDLE[kind].map((b) => ({
          ...b,
          installed: files.some((f) => FILE_PATTERNS[b.id]?.test(f)),
        }))
      : [];
    return {
      serverId,
      score,
      grade: securityGrade(score),
      exposure,
      checks,
      bundle,
      checkedAt: new Date().toISOString(),
    };
  }

  /** Apply the fix of one check. */
  async fix(serverId: string, checkId: string) {
    const row = await this.servers.row(serverId);
    let message: string;
    switch (checkId) {
      case "online-mode":
        await this.servers.setAuthMode(serverId, true);
        message = "Player login is on. Restart the server to apply it.";
        break;
      case "whitelist":
        message = await this.#whitelist(serverId);
        break;
      case "proxy-forwarding":
        await this.#disableBungee(row);
        message = "BungeeCord mode is off. Restart the server to apply it.";
        break;
      case "query":
        await this.servers.updateProperties(serverId, { "enable-query": false });
        message = "Query is off. Restart the server to apply it.";
        break;
      case "grief-log": {
        const id = row.software === "fabric" ? "ledger" : "coreprotect";
        await this.addons.install(serverId, "modrinth", id, true);
        message = `${id === "ledger" ? "Ledger" : "CoreProtect"} is installed. Restart the server to load it.`;
        break;
      }
      case "host-firewall":
        await this.hostAdmin.harden(row.hostId, "firewall");
        message =
          "The host firewall is on: SSH and the game ports are open, everything else is closed.";
        break;
      case "ssh-passwords":
        await this.hostAdmin.harden(row.hostId, "password-login-off");
        message = "SSH now accepts keys only.";
        break;
      case "fail2ban":
        await this.hostAdmin.harden(row.hostId, "fail2ban");
        message = "fail2ban is on.";
        break;
      case "auto-updates":
        await this.hostAdmin.harden(row.hostId, "auto-updates");
        message = "Security updates now install automatically.";
        break;
      case "firewall":
      case "rcon":
        if (row.hostId !== LOCAL_HOST_ID) {
          await this.hostAdmin.harden(row.hostId, "firewall");
          message = "The host firewall is on: the RCON port is closed to the internet.";
          break;
        }
        await this.network.fixFirewall(serverId);
        message = "Windows Firewall now allows Java on the game ports only.";
        break;
      default:
        throw new ServerError("VALIDATION", `Nothing to fix for ${checkId}`);
    }
    this.#cache.delete(serverId);
    return { message, report: await this.report(serverId, true) };
  }

  /**
   * One click: every automatic fix that applies, plus the chosen plugins.
   * The firewall is left to its own button, since Windows asks for permission.
   */
  async harden(serverId: string, plugins: string[]) {
    const before = await this.report(serverId, true);
    const done: string[] = [];
    const failed: string[] = [];
    for (const c of before.checks) {
      if (c.fix?.kind !== "auto" || c.id === "grief-log") continue;
      // A private server's whitelist still gets turned on: hardening means "ready to share".
      if (c.status === "pass" || (c.status === "info" && c.id !== "whitelist")) continue;
      try {
        const r = await this.fix(serverId, c.id);
        done.push(r.message);
      } catch (err) {
        failed.push(`${c.title}: ${errMessage(err)}`);
      }
    }
    const row = await this.servers.row(serverId);
    const kind = row.software === "fabric" ? "mod" : row.software === "vanilla" ? null : "plugin";
    const allowed = new Set<string>(kind ? BUNDLE[kind].map((b) => b.id) : []);
    const files = await this.#addonFiles(row);
    for (const id of plugins) {
      if (!allowed.has(id)) continue;
      if (files.some((f) => FILE_PATTERNS[id]?.test(f))) continue;
      try {
        await this.addons.install(serverId, "modrinth", id, true);
        done.push(`Installed ${id}.`);
      } catch (err) {
        failed.push(`${id}: ${errMessage(err)}`);
      }
    }
    this.#cache.delete(serverId);
    return { done, failed, report: await this.report(serverId, true) };
  }

  // --- internals ------------------------------------------------------------------

  async #addonFiles(row: ServerRow): Promise<string[]> {
    if (row.software === "vanilla") return [];
    const folder = row.software === "fabric" ? "mods" : "plugins";
    const entries = await this.servers
      .agentOf(row)
      .listDir(row.directory, folder)
      .catch(() => []);
    return entries.filter((e) => e.kind === "file" && /\.jar$/i.test(e.name)).map((e) => e.name);
  }

  /** Whitelist on, with everyone who has played here (and the operators) on it. */
  async #whitelist(serverId: string): Promise<string> {
    const overview = await this.players.overview(serverId);
    const names = new Set<string>();
    for (const p of overview.known) if (p.named && !p.banned) names.add(p.name);
    for (const o of overview.ops) names.add(o.name);
    const already = new Set(overview.whitelist.map((w) => w.name.toLowerCase()));
    let added = 0;
    for (const name of [...names].slice(0, 200)) {
      if (already.has(name.toLowerCase())) continue;
      try {
        await this.players.action({ serverId, action: "whitelist_add", target: name });
        added++;
      } catch {
        // an unknown name (Mojang lookup failed) is skipped
      }
    }
    await this.players.setWhitelist(serverId, true);
    await this.servers.updateProperties(serverId, {
      "white-list": true,
      "enforce-whitelist": true,
    });
    return added > 0
      ? `The whitelist is on; added ${added} player${added === 1 ? "" : "s"} who played here.`
      : "The whitelist is on.";
  }

  async #disableBungee(row: ServerRow): Promise<void> {
    const agent = this.servers.agentOf(row);
    const text = await agent.readFile(row.directory, "spigot.yml");
    const next = text.replace(/^(\s*bungeecord:\s*)true(\s*)$/m, "$1false$2");
    if (next !== text) await agent.writeFile(row.directory, "spigot.yml", next);
  }
}
