# Plan: Multi-cloud Minecraft Server Manager

## Context

Goal: an exaroton/aternos-style Minecraft server manager that, instead of hosting for you, drives **your own** infrastructure. It provisions and manages servers on your cloud accounts (AWS, GCP, Azure, Linode, Hetzner, ...), walks beginners through picking and setting up a cheap VPS, or self-hosts on the local machine with tunnelling and hardened defaults. Every server, wherever it lives, gets the same sleek dashboard: live console, CPU/RAM/TPS, players, versions, properties, files, plugins, backups, schedules.

Decisions already made:
- **Form factor:** self-hosted web app (single process you run, open in a browser).
- **Stack:** full TypeScript. Node 24 LTS + pnpm workspaces. (Bun is not used as the runtime because `ssh2` and other native deps are proven on Node; Bun can be revisited later.)
- **First milestone:** self-host on this machine (Windows), no cloud account needed to develop.
- **Users:** single owner, password login, credentials encrypted locally.

Project directory is empty. Node is not installed yet; Go 1.24 and Python 3.13 are present but unused.

First implementation step: copy this document to `plan.md` in the project root.

---

## Suggested extra features (beyond the brief)

Marked ★ = recommended for the core roadmap, ☆ = stretch.

- ★ **Idle auto-stop + wake-on-connect.** Stop the MC process (and optionally the cloud VM) when empty for N minutes. A tiny "sleeper" listener answers server-list pings with "Server sleeping, join to start" and starts it on join (lazymc-style). This is exaroton's killer feature and the main cost saver on cloud.
- ★ **Cost meter.** Per-server estimated $/hour and month-to-date from the provider's price list × uptime. Show before provisioning ("this config costs ~$X/mo").
- ★ **One-click hardening profile.** Toggle set: online-mode, whitelist, ops, RCON on localhost only, query off, firewall rules, fail2ban on hosts, recommended anti-grief plugins (CoreProtect, LuckPerms, WorldGuard/GriefPrevention, spark) with sane configs.
- ★ **Automatic Java management.** Detect the JDK a version needs (8/16/17/21) and download it from Adoptium so users never install Java.
- ★ **Plugin/mod browser.** Modrinth + Hangar (+ CurseForge with a user API key) search and install with version compatibility filtering, plus update checks.
- ★ **Backups with off-site targets.** Scheduled, pre-update, and manual snapshots; restore; push to S3/B2/any S3-compatible bucket; retention policy.
- ★ **Schedules.** Cron-style restart, backup, broadcast, command.
- ★ **Crash detection + auto-restart** with crash-report viewer and a "why did it crash" summary (OOM, port in use, EULA, wrong Java).
- ★ **Player management.** Online list with kick/ban/op/whitelist, ban list editor, player history and playtime.
- ★ **Bedrock crossplay.** One toggle installs Geyser + Floodgate on Paper/Fabric.
- ★ **Server migration.** Move a server between hosts (local → cloud, cloud A → cloud B) via backup + restore.
- ☆ **Modpack import** from Modrinth `.mrpack` / CurseForge manifest.
- ☆ **Discord webhook notifications** (start/stop/crash/join/leave).
- ☆ **Multi-user + roles** (owner/admin/moderator) and invite links, later.
- ☆ **Proxy networks** (Velocity) linking multiple servers.
- ☆ **Mobile-friendly PWA** layout for the dashboard.
- ☆ **Public status page** per server (MOTD, players, uptime).

---

## Architecture

```
┌──────────────────────────── Panel (apps/server) ────────────────────────────┐
│ Fastify + tRPC + WebSocket · SQLite via libsql (Drizzle) · encrypted credential store    │
│ Provider adapters (cloud APIs) · Host drivers · Scheduler · Backup engine     │
└───────────┬───────────────────────────┬─────────────────────────┬────────────┘
            │ WS → 127.0.0.1            │ SSH tunnel → 127.0.0.1  │ SSH tunnel
            ▼                           ▼                         ▼
   Local agent daemon           Agent on VPS (generic SSH)   Agent on cloud VM
   spawns java, metrics, files  same code, Linux binary      provisioned via API
```

Key ideas:
- **Host** = a machine that can run servers (`local`, `ssh`, or `cloud` kinds). Cloud providers create hosts; after that every host is managed identically.
- **Agent** = one small program (`apps/agent`) that supervises MC processes, streams console + metrics, and does file ops. It always runs as its own daemon and is reached over a token-authenticated WebSocket on `127.0.0.1`: locally directly, on remote hosts through an SSH port-forward. It never listens publicly and needs no extra firewall rules.
- **Servers outlive the panel.** Restarting, updating or crashing the panel never stops Minecraft. On Windows the local daemon is created through WMI so it escapes the panel's process tree and any job object (Turbo, `taskkill /T`); on Unix a detached double-spawn does the same. On reconnect the panel adopts whatever the agent reports. An idle agent (no servers, no panel) exits after 10 minutes.
- **Provider** = adapter that can list regions/sizes/prices, create/stop/start/destroy a VM with cloud-init, and open the MC port. Output is a Host.
- **Frontend** talks tRPC for CRUD and one WebSocket for console/metrics/status streams.

### Monorepo layout

```
apps/
  server/        Fastify + tRPC API, WebSocket hub, scheduler, DB, auth
  web/           React 19 + Vite + Tailwind v4 + shadcn/ui, TanStack Router/Query
  agent/         Host agent (Node, bundled to single file; also embedded by server)
packages/
  shared/        zod schemas, tRPC router types, enums, constants
  providers/     provider adapters: hetzner, aws, gcp, azure, linode, digitalocean, vultr, oracle
  mc/            Minecraft knowledge: version manifests, software downloaders, Java matrix, server.properties schema, log parsers
  tunnels/       playit.gg, ngrok, UPnP, Tailscale helpers
plan.md · package.json · pnpm-workspace.yaml · turbo.json · biome.json · docker/
```

### Data model (SQLite via Drizzle)

`users` (single row) · `sessions` · `credentials` (provider, label, AES-256-GCM blob) · `hosts` (kind, provider, provider_ref, ip, ssh key ref, agent token, status) · `servers` (host_id, name, software, mc_version, java_version, memory_mb, port, status, settings json) · `backups` · `schedules` · `audit_log` · `settings`.

Master key for credential encryption: derived from the login password with argon2id, cached in memory while logged in; alternatively `CUBEHOLD_MASTER_KEY` env for unattended boots.

### Agent protocol (JSON-RPC over WebSocket, token auth)

Implemented: `hostInfo`, `start`, `stop`, `kill`, `send`, `command` (RCON reply), `status`, `players`, `running`, `setPolicy`, `sleep`, `snapshot` (recent console, falling back to `logs/latest.log`), `busyPorts`, `readFile`, `writeFile`, `listDir`, `stat`, `copyInto`, `removePaths`, `removeDir`, `makeDir`, `rename`, `zip`, `unzip`, `zipEntries`, `inspectJars`, plus `agent.shutdown`. HTTP on the same port: `GET/PUT /files`, `GET /zip`. Events: `line`, `status`, `exit` (reason, crash report, restart delay, idle stop), `metrics` (CPU, RSS, heap, TPS, MSPT), `players`, `progress`.
Planned: `java.ensure` in the agent (M4), disk and network metrics.

### Minecraft knowledge (`packages/mc`)

- Version sources: Mojang piston-meta manifest (vanilla), PaperMC Fill API v3 (Paper/Velocity; v2 was sunset in 2026), Purpur API, Fabric meta, NeoForge/Forge maven, Bedrock download page.
- Java version: taken from the source when it states one (Mojang `javaVersion`, Paper `java.version.minimum`). Fallback matrix: <1.17 → 8, 1.17 → 16, 1.18–1.20.4 → 17, 1.20.5–1.21.x → 21, 26.x → 25. JREs from Adoptium, SHA-256 verified.
- Launch: Aikar's flags scaled to memory; EULA auto-accept after user consent click.
- `server.properties` typed schema (booleans, enums, ranges) drives the settings form.
- Log parser: player join/leave, "Done (x s)", TPS (Paper `tps` via RCON), crash signatures.
- Query/ping via `minecraft-server-util`; RCON via `rcon-client` bound to localhost.

### Tunnelling (self-host)

Offer, in order: **playit.gg** (free, MC-first, works behind CGNAT; run their agent and show claim link), **UPnP auto port-forward** with a reachability check, **manual port-forward guide** with public IP detection, **Tailscale** for private friend servers, **ngrok TCP** for users with an account. Cloudflare Tunnel is excluded (Java clients cannot connect through it without a client-side tool).

### Cheap hosting guidance

Comparison table with live prices where an API exists: Oracle Cloud Always Free (ARM 4 OCPU/24 GB, $0), Hetzner CX22/CAX11 (~€4), Contabo, OVH, Vultr, DigitalOcean, Linode, AWS Lightsail/EC2, GCP e2, Azure B-series. Recommender takes player count + modded/vanilla and suggests RAM/CPU tier. Two onboarding paths: (a) provider has an API → wizard: create account → create API token (with screenshots/links) → paste → provision; (b) no API integration → "Generic VPS" wizard: user creates the VM, pastes IP + root password or key, panel installs the agent over SSH.

### Security defaults

Panel: argon2id password, secure session cookie, CSRF on mutations, rate-limited login, optional TOTP (later). Credentials never leave the encrypted store; API tokens are shown once. Remote hosts: dedicated `minecraft` user, ufw with only 22 + MC port, fail2ban, agent on localhost via SSH forward, RCON on localhost, automatic OS security updates via cloud-init. Servers: online-mode on, whitelist on, query off, sane max-players/view-distance.

---

## Implementation milestones

### M0 — Scaffold (day 1) ✅ done 2026-09-27
- Install Node 24 LTS + pnpm. Create pnpm workspace, Turborepo, Biome, TypeScript project refs, Vitest.
- `apps/server`: Fastify, tRPC v11, `ws`, Drizzle + @libsql/client, zod, pino. Health route, auth (setup-owner flow, login, session).
- `apps/web`: Vite + React 19 + Tailwind v4 + shadcn/ui, TanStack Router + Query, dark/light theme, app shell (sidebar, server list, settings).
- `packages/shared`: schemas for User, Host, Server, Credential, events.
- Copy this plan to `plan.md`.

### M1 — Local host + first server (MVP) ✅ done 2026-09-28
- `apps/agent` core: process supervisor (spawn java, stdin pipe, stdout line stream, exit codes and exit reasons), path-safe file ops, CPU/RAM sampling without native modules (PowerShell on Windows since `wmic` is gone, `/proc` on Linux, `ps` on macOS).
- Agent runs as a detached daemon, not in-process (see "Servers outlive the panel"). `pnpm agent:status` / `pnpm agent:stop`.
- `packages/mc`: Mojang + Paper + Fabric version lists, Adoptium Java download, EULA, `server.properties` schema, launch flags, log parser.
- Create-server wizard: software → version → RAM → port → name → EULA. Start/stop/restart/kill.
- Dashboard: overview tiles with CPU/RAM sparklines and players, live console (xterm.js) with command history, install progress, delete.
- Settings tab: typed `server.properties` form that preserves comments and unknown keys.
- Deferred to M2: TPS (needs RCON), Purpur/Forge/NeoForge installers.

### M1.5 — Lifecycle ✅ done 2026-09-28
- Change Minecraft version up or down from Settings: staged download (nothing changes if it fails), Java switch, world snapshot per version under `data/backups/<id>/versions` (newest per version, max 5), downgrade world choice (restore snapshot / keep / fresh), auto stop and restart.
- Offline mode: one switch at creation and in Settings sets `online-mode` and `enforce-secure-profile`; badge in lists and header.
- Delete: optional verified export to a user folder (worlds, addons, config, logs, snapshots), then server folder, snapshots and orphaned Java runtimes are removed and checked gone. Interrupted deletes reappear for retry.
- Java runtimes are reference-counted: removed when no server needs them (after delete, version change, install, and at boot).
- Note for M4: Java download and GC run in the panel process for the local host; move them into the agent for remote hosts.

### M2 — Full dashboard ✅ done 2026-09-28
- RCON managed by the panel (random 64-hex password, unique port from 25575, written to server.properties before each start). The agent keeps one connection per server and sends one packet at a time: vanilla's RCON reader drops the connection if two packets arrive in one read. Used for command replies, TPS/MSPT (`tps` + `mspt` on Paper/Purpur, `tick query` on vanilla 1.20.3+) and a `list` resync every minute.
- Memory: heap in use after the last GC, read from a small rotating GC log (`-Xlog:gc`, Java 9+) in `.cubehold/`. Wizard and settings count JVM overhead (300 MB + 10% of heap) against host RAM.
- Players tab: online list with op/kick/ban, whitelist toggle and list, ops, player and IP bans, playtime history (`player_sessions` table). Live via RCON; while stopped, edits the JSON lists directly (Mojang UUID lookup, or offline UUIDs).
- File manager: list/edit (CodeMirror 6, JSON/YAML/properties/TOML), upload (streamed HTTP PUT through the agent, drag and drop), download (files, or folders zipped on the fly), rename, delete, compress, extract (zip-slip safe, free-space check). Agent serves streams over HTTP on its own port with the same token.
- Backups: zip (yazl/yauzl, ZIP64, region files stored not deflated) under `data/backups/<id>/archives`; live backups use save-off / save-all flush / save-on; restore stops the server, takes a safety backup, replaces the backed-up scope, restarts. Retention prunes scheduled and pre-restore backups; manual ones stay.
- Schedules: croner, five-field cron in the panel's time zone; restart/stop with in-game countdown, start, backup, command, broadcast; run now; last result recorded.
- Crashes: agent restarts after a crash (10 s / 30 s / 60 s, at most 3 in 10 min, not for EULA/port/Java errors); crash report or JVM error log found per run; analysis with cause, hint and suspect plugins; crash card and report viewer.
- Plugins/mods: Modrinth (plugins and mods, server-side only) and Hangar search filtered by loader and version; install with required Modrinth dependencies; installed list identified by SHA-1 through Modrinth plus a manifest for Hangar; updates; disable (`.jar.disabled`); remove with optional config folder. Downloads verified in the panel, then uploaded through the agent.
- Idle stop + wake-on-join in the agent: stop after N minutes empty, then a sleeper answers pings ("Sleeping") and starts the server on a login attempt. The panel re-arms sleepers if the agent restarts.
- Server edit: name, memory, port, extra JVM args, automation, backup retention.
- Player page (after M2 review): live health/hunger/XP/position via short `/data get` queries (Paper truncates long ones), inventory and ender chest from `playerdata/<uuid>.dat` after a throttled `save-all`, stats from `stats/<uuid>.json`, advancements count; kill/starve/heal/feed, gamemode, teleport (coords or player), give (item catalog), clear, message; whitelist/ban/op toggles. Inventory drawn with the game's GUI and item textures from the client jar (per version under `data/assets`, garbage-collected like Java): item model resolution for flat items, isometric blocks, chests, shulker boxes, heads, shields; tints; enchant glint; durability; game-style tooltips. Player history now covers everyone with saved data (deaths, playtime from game stats).
- Purpur support. Still deferred: Forge/NeoForge installers, CurseForge (needs a user API key), off-site backup targets (S3/B2), Hangar dependency auto-install, datapacks for vanilla.
- Note for M4: plugin and jar downloads happen in the panel and are uploaded to the host; schedules run in the panel. Consider moving schedules into the agent so they survive a panel outage.

### M3 — Self-host exposure + hardening ✅ done 2026-09-28
- `packages/tunnels` (no dependencies):
  - **UPnP IGD client** written in-house instead of the unmaintained `nat-upnp`. SSDP search goes out on every LAN adapter, default route first; machines with VPN, WSL or VirtualBox adapters otherwise miss the router. IGD v1/v2, WANIP/WANPPP, SOAP over node:http with exact header casing, retry for routers that drop every other connection (the Sagemcom F@st5359 does).
  - **`PortMapper`** keeps one-hour leases renewed every 20 minutes. It falls back to a permanent forward on error 725, never touches forwards it did not make, and clears its own on agent shutdown.
  - **Network helpers:** LAN, Tailscale and default-route addresses, public IPv4/IPv6 (ipify), WAN classification (public, CGNAT, double NAT) and VPN detection.
  - **playit.gg API client:** claim setup and exchange, `/v1/agents/rundata`, and the GitHub release asset with its SHA-256 digest.
  - **Status-ping client** with SRV lookup (joinmc.link), plus mcstatus.io outside checks.
  - **Windows Firewall** read through the HNetCfg.FwPolicy2 COM object (under a second, no admin). Evaluation mirrors Windows: block rules win, profiles apply, program- and port-scoped rules. Fixes run as one elevated PowerShell script (UAC).
- Agent:
  - Supervises the official playitd with `--secret` and its own IPC pipe. It restarts it with backoff, stops on a rejected secret, and cleans up leftovers by pid file plus an image-path check.
  - Maintains UPnP forwards.
  - Opens a temporary status listener ("probe") so outside tests work on stopped servers; it is closed before a start or sleep takes the port.
  - Reads the firewall and runs the elevated fix.
- Panel:
  - **PlayitService:** claim flow, secret in the encrypted credential store (starts after login or with `CUBEHOLD_MASTER_KEY`), binary downloaded and checked weekly for updates. Agent secrets cannot create tunnels (playit's API makes them read-only), so the Network tab tells the owner exactly what to add on playit.gg and picks the tunnel up by local port.
  - **NetworkService:** per-server addresses, UPnP sync on port or name changes, and outside tests that wait out mcstatus.io's one-minute cache and match a one-off MOTD token when the probe answers. Failure hints cover VPN, CGNAT, double NAT, firewall, and a missing or failed forward.
  - **BedrockService:** Geyser and Floodgate from GeyserMC's download API for Paper and Purpur (Floodgate on Hangar is stale since 2023), from Modrinth for Fabric, and ViaVersion when the server is behind the newest release. Each server gets its own UDP port from 19132, passed as `-DgeyserUdpPort`; Geyser switches to Floodgate login by itself.
  - **SecurityService:** 11 checks, score 100 minus severity weights (warnings count half), severity raised when the server is reachable from the internet. Fixes: online mode, whitelist (adds everyone who played plus ops first), BungeeCord off, query off, CoreProtect/Ledger, firewall. "Harden" applies every automatic fix plus chosen plugins. It is an action rather than a lock: the score shows drift afterwards.
  - **Log4Shell:** vanilla and Fabric 1.7 to 1.16.5 get Mojang's log4j XML (SHA-1 checked) and `-Dlog4j.configurationFile` at launch.
- Web: Network and Security tabs, Overview join-address and security card, Hosts page network section with playit.gg link/unlink and the daemon log.
- After review (2026-09-29):
  - **ngrok, Tailscale, Cloudflare Tunnel:** the agent's tunnel supervisor now runs playit, ngrok or cloudflared from a command line the panel builds (tokens in the environment and scrubbed from logs). Public addresses come from ngrok's `/api/endpoints` and cloudflared's metrics server (`/ready`, `/config`).
    - ngrok is downloaded from its stable channel, with the Authenticode signature checked on Windows. cloudflared comes from GitHub with its SHA-256.
    - Tailscale goes through its CLI: status, sign-in link, Funnel TCP forwards on 443/8443/10000, and winget install.
  - **playit:** a clearer "add a tunnel" step, account notices (email verification) shown prominently, and a best-effort "create the tunnel for me" through `/v1/tunnels/create` that falls back to the steps.
  - **Minecraft 26.1 layout:** player data, stats and advancements moved to `world/players/{data,stats,advancements}`. The panel picks the layout on disk, then by version.
  - **Stop:** also sent over RCON, with a console note (a server that is still loading only handles stop once it has finished).
- Not done:
  - NAT-PMP/PCP (Apple routers).
  - Linux firewall checks (ufw needs root; M4 sets ufw up itself).
  - Bedrock for vanilla (would need Geyser Standalone).
  - Creating playit tunnels automatically (not allowed by playit's API).

### M4 — Remote hosts over SSH (generic VPS) ✅ done 2026-09-29
- **Host-agnostic agent.** Installs moved into the agent: `stageBinaries` (Java from Adoptium plus the jar, checksums verified, on the server's own host), `commitBinaries`, `writeInitialFiles`, `ensureJava`, `gcJava` and `fetchUrl`, with "install" progress events. Each agent owns a data folder (`servers/`, `backups/`, `java/`). The panel builds paths with the host's own path functions (POSIX for a Linux VPS, whatever the panel runs on), so a Windows panel manages Linux hosts.
- **SSH (`ssh2`, pure JS):**
  - `SshSession`: host-key pinning (SHA256 fingerprint as `ssh-keygen -lf` prints it), password, key or keyboard-interactive login, and root through root, passwordless sudo or sudo with a password. Root scripts travel on stdin into a private temp file; files are written atomically with mode and owner.
  - `LocalForward`: one 127.0.0.1 port per host that carries the agent's WebSocket and HTTP streams through the current SSH session.
  - `RemoteHostLink`: states online / connecting / offline / agent-down / locked / error, keepalives, reconnect with backoff (2 s to 60 s). It stops on login or host-key failures, since retrying a refused login would trip fail2ban.
- **Setup of a fresh Ubuntu/Debian VPS** (HostService, a job with steps and a command log):
  1. Log in and check the system (OS, arch, systemd, apt, memory, disk, root access).
  2. Install a per-host ed25519 panel key and prove it works; the user's password is not kept.
  3. apt packages, after waiting for cloud-init.
  4. A system account `cubehold`.
  5. The Node.js build matching the panel, checked against nodejs.org's SHA256SUMS.
  6. The agent bundled by esbuild into one file, run as a hardened systemd unit (`User=cubehold`, `ProtectSystem=strict`, `NoNewPrivileges`, loopback only, token in a root-only env file).
  7. Connect through the tunnel.
  8. ufw with SSH allowed first and a 3-minute systemd-run guard that turns it off again unless a fresh login succeeds. It also drops Oracle's iptables REJECT rule.
  9. fail2ban and unattended-upgrades.
- **Keeping hosts right:**
  - Game ports (TCP, plus UDP for Bedrock) are opened and closed in ufw as servers are created, changed, moved or deleted.
  - Idle agents are updated to the panel's build on connect; Repair reinstalls.
  - Security panel and checks: firewall, fail2ban, automatic updates, SSH keys only.
  - Removal can uninstall everything, including the panel's key.
  - After a panel restart the credential store is locked; a banner unlocks it and hosts reconnect.
- **Moving servers** between any two hosts (ServerMover): stop, zip, stream agent to agent through the panel, unzip, compare file counts, then switch the row (same id, so schedules, history, crashes and backups stay), then delete the old copy. Backups travel along or are dropped; UPnP/ngrok flags reset and the Bedrock port is re-picked.
- **Web:**
  - Hosts page with VPS cards: usage, agent version, setup/repair progress, security.
  - Add-a-VPS wizard: login, fingerprint, protection options, live setup.
  - "Getting a VPS" guide: sizing helper (`recommendVps`) and a provider table with prices checked in September 2026.
  - Host picker and per-host memory limits in the new-server wizard; Move card in Settings; VPS network view; offline-host banners.
- Verified against a throwaway Ubuntu 24.04 WSL distro with sshd on 2222:
  - Setup in 20 s.
  - Paper 1.21.11 installs Java 21 on the host, runs, a bot joins over the network; stop, backup.
  - Moves VPS to local and back with backups.
  - Agent down leads to Repair; a stale agent is auto-updated; a "reboot" goes offline and back.
  - Locked vault after restart, then unlock.
  - Keys-only SSH.
  - Setup as a key-only `ubuntu` user with passwordless sudo; sudo-with-password detection.
  - Uninstall leaves nothing.
- Not done:
  - Non-apt distributions (RHEL, Fedora, Alpine). The check refuses them with a clear message.
  - Provider-side firewalls (security groups): M5 opens them through the provider APIs; for now the network tab explains them.
  - Schedules still run in the panel; they pause while a host is offline.
  - Node SEA single binary: a Node runtime per host plus one bundled file does the same job with less build tooling.

### M5 — Cloud providers ✅ done 2026-09-29
Scope chosen by the owner: Hetzner, DigitalOcean, Vultr, Linode and AWS (GCP, Azure and Oracle later), tested against fake provider APIs rather than paid accounts, a per-server choice for idle VMs, and starting VMs from the panel only.
- **`packages/providers`**: one `CloudProvider` interface.
  - Operations: verify, regions, sizes with list prices, SSH key, firewall (SSH plus game ports), create/get/start/stop/delete VM, snapshot, snapshot state, delete snapshot. Errors become `CloudError`s with advice (bad token, missing permission, vCPU quota, no capacity, region not enabled).
  - Hetzner, DigitalOcean, Vultr and Linode use their REST APIs through one client with retries; AWS uses the SDK (EC2 + Price List) in the default VPC with a security group.
  - Every VM, firewall and key carries a per-host tag. Hetzner and DigitalOcean attach firewalls by label or tag, so a VM restored from a snapshot is covered again. Linode takes the key inline, with a throwaway root password.
  - Wizard steps and an AWS least-privilege IAM policy (start/stop/terminate only on instances tagged by the panel).
- **Costs:** billing rules per provider (Sep 2026):
  - Stopped VMs are billed in full except on AWS; bills are capped at the monthly price except on AWS.
  - Snapshot storage: €0.0143/GB (Hetzner), $0.06 (DigitalOcean), $0.05 (Vultr), $0.10 (Linode), $0.05 (AWS).
  - Also counted: AWS EBS while stopped plus IPv4 while running; Hetzner IPv4 €0.50 a month.
  - Month-to-date usage is tracked per host by power state; the host card shows the cost so far, last month, and "3 hours a day" estimates for every size.
- **CloudService:**
  - Accounts, verified then stored encrypted.
  - Create a host: provider key, then firewall, then VM, then boot, then the first SSH login, which learns the host key. After that the same setup as an M4 VPS, plus keys-only SSH.
  - Power: start, stop (clean OS shutdown over SSH, then provider stop, then force), and save-and-delete (snapshot, delete the VM only once the snapshot is ready, restore on Start, then delete the snapshot). cloud-init is told to keep SSH host keys, so a restored VM keeps its identity.
  - Starting a server on an off VM boots or restores the VM first and then starts the server.
  - Idle: per-server "Then turn the VM off" (keep / stop on AWS / save and delete elsewhere). Once idle stops leave nothing running and every server here allows it, the VM goes down after 2 minutes; wake-on-join is disabled for those servers.
  - Provider firewall kept in sync with game ports. A monitor notices VMs started, stopped, deleted or given a new IP in the provider's console, and recovers states left by a panel restart.
  - Cloud state has its own column with writes serialized per host.
- **Web:** Cloud accounts with the token wizard (and AWS policy); "Create a cloud server" with locations by continent, sizes with fit, best pick and prices; cloud host cards with price, month cost, Start / Stop / Save and delete / Delete VM; VM idle choice on the automation card; a note on servers whose VM is off.
- **Verified:**
  - Adapters: each provider's full life cycle against fake APIs checks the request bodies against the providers' documented fields.
  - End to end: a fake Hetzner API whose VMs are WSL distros (`wsl --import` / `--export` as create and snapshot). Create and setup in 40 s, a Paper server with a bot, VM stop/start, and the idle save-and-delete and restore.
- **Not done:**
  - GCP, Azure, Oracle.
  - Reserved/elastic IPs: the address changes after an AWS stop or a restore from a snapshot.
  - Idle power-down needs the panel running; an AWS VM could power itself off (planned: an agent-side trigger).
  - Live tests against real accounts, left to the owner.
- Found by the end-to-end run and fixed:
  - Restart could fail with "already running" because the exit event was still being saved; it now waits for it.
  - A start that failed after "starting" was saved (host dropped) left the server "starting" for ever; it falls back to "stopped".
  - A provider answering "not found" once made the panel forget the VM id. The id is now kept and checked again, so the VM is recovered if it comes back.
  - A VM reported as running without an address no longer wipes the known address.
  - A running VM left without an SSH link (slow SSH after a restore) is reconnected by the monitor.

### M6 — Polish + distribution ✅ done 2026-09-30
Scope chosen by the owner: keep the name cubehold for now; Windows as a per-user tray app with an optional start at sign-in; Discord through webhooks only; all extras (modpacks with Forge/NeoForge, phone layout, onboarding, docs site).
- **Release build (`pnpm dist`, packaging/build.ts):**
  - The panel (`server.mjs`) and agent (`agent.mjs`) bundled with esbuild, plus the web app, migrations, a package.json and THIRD-PARTY-NOTICES.txt.
  - argon2 and libsql stay native modules, installed by npm per target (`--os/--cpu/--libc`).
  - `--target win-x64 | linux-x64 | linux-arm64 | darwin-arm64` adds Node.js (checked against SHASUMS256.txt) and makes a zip or tar.gz.
  - A release knows it is one (`__CUBEHOLD_DIST__`): per-OS data folder by default (`%LOCALAPPDATA%\cubehold`, `~/.local/share/cubehold`, `~/Library/Application Support/cubehold`), NODE_ENV production, the web app served by the panel (CSP with a hash for the inline theme script, immutable caching for hashed assets), and the prebuilt agent for the local daemon and for VPS hosts.
  - `cubehold` CLI: panel (default), `agent` (foreground, for Docker/systemd), `agent status [--json]`, `agent stop`, `--version`.
- **Local agent:** the panel restarts it if it dies (5 s), and replaces an idle agent that runs older code or from an older install folder (new `execPath` in the hello).
- **Windows:**
  - Tray app `cubehold.exe` (C# 5, built with the csc.exe in every Windows).
  - It runs the panel hidden in a kill-on-close job object, restarts it after crashes (2 s to 60 s, gives up after 5 in 10 minutes with the reason), and opens the browser when ready.
  - Menu: Open, Start when I sign in (HKCU Run), data folder, log, Restart panel, Quit (asks about running servers).
  - Sign-out and shutdown save the worlds first behind a shutdown block reason. `--quit` and `--uninstall` serve the installer.
  - Inno Setup per-user installer (no admin): each version in `app-<version>` next to cubehold.exe, so an update never touches the files a running agent uses. The tray deletes old folders once free. Uninstall stops servers and asks before deleting data (default no). Settings in `%LOCALAPPDATA%\cubehold\launcher.env`.
- **Docker:** one image, two containers with host networking (agent with a 3-minute stop grace period; panel with `CUBEHOLD_AGENT=external`, which reads the agent's port and token from `agent.json` on the shared volume). Linux archives ship systemd units for the same split.
- **Discord:** a webhook per server (only Discord's hosts accepted). Events: start/stop/sleep, crash (with the analysis), joins/leaves, backup finished/failed, cloud VM power (new `power` event from CloudService). The rules:
  - Only transitions the panel sees are posted; statuses and player lists reported after a restart are a baseline.
  - Each server's events are handled in order.
  - Messages go one at a time per webhook, with 429s waited out, `allowed_mentions: []`, and Markdown escaped in names.
  - The last delivery error shows on the card, next to "Send a test".
- **Forge and NeoForge:** version lists from promotions_slim.json and NeoForge's maven metadata (21.1.x means 1.21.1; 26.1.2.x means 26.1.2). The agent runs the official installer (`--installServer`) in the staging folder and moves everything it wrote into the server. 1.17+ launches through `@libraries/.../win_args.txt` or `unix_args.txt` (chosen by the host's OS); older Forge through the jar the installer writes. A loader version can be pinned (modpacks).
- **Modpacks:** Modrinth search and versions, or an uploaded `.mrpack`.
  - The pack is validated: relative paths only, downloads from the four hosts the format allows, and a checksum on every file.
  - The server is created with the pack's loader pinned. An after-install step (still "installing") downloads each server file on the host with its sha512, then copies `overrides/` then `server-overrides/` as one uploaded zip.
  - The pack's `server.properties` is merged except the port, login mode, RCON, query, whitelist and MOTD.
  - A failed step reruns on Start. Memory is suggested from the mod count.
- **Phone:** bottom navigation and sticky header on small screens, toasts above the bar, manifest with icons (including maskable), a service worker that caches hashed assets and shows an offline page (HTTPS or localhost only). Settings explains LAN access (`HOST=0.0.0.0`) and Tailscale Serve.
- **Onboarding:** a checklist on the Servers page worked out from the database (create, start, friends can join, security score ≥ 80, a backup schedule, Discord), hidden with ✕ and brought back from Settings.
- **Docs site:** VitePress in `docs/` (15 pages for owners: install for each platform, first server, friends, VPS, cloud, modpacks, backups, security, Discord, phone, updating, troubleshooting, commands and settings). `pnpm docs` / `pnpm docs:build`.
- **E2E (Playwright, `e2e/`):** runs against `build/app` with its own data folder (or an existing panel via `CUBEHOLD_E2E_URL`). Tests:
  - Paper: create, start, console command, a mineflayer player joins and chats, stop, delete.
  - A NeoForge modpack built at test time: upload, install, overrides and the property merge, start.
  - Phone layout.
  - Onboarding.
- **Verified:**
  - 160 unit tests, lint and typecheck.
  - The 12 e2e tests pass against the Windows release build, and against the Docker containers from a fresh volume (owner setup, NeoForge installer inside the Linux container, a player joining over the network).
  - The Windows installer:
    - install, tray start, and panel crash restart,
    - agent watchdog, and an update 0.1.0 → 0.1.1 where the running agent survived and was replaced once idle,
    - the old version folder removed, and a clean uninstall.
  - The Docker image in a throwaway WSL Ubuntu 24.04 with compose (panel ↔ agent over host networking).
  - The Linux x64 archive in the same distro: as the two systemd services from the docs, and in its quick `./cubehold` mode with its own agent.
- **Found by the end-to-end runs and fixed:**
  - Forge/NeoForge console lines have a third bracket group (`[minecraft/DedicatedServer]`), so "Done" and joins were never seen and servers stayed "starting". The prefix is now matched up to the first `]: `.
  - The crash card told owners to update mods when a mod needs a newer loader; there is now a specific explanation.
  - The bundled panel crashed at start because ssh2 reads `__dirname`; the bundle defines it.
  - A local agent left in an older version's folder kept that folder forever.
  - The new CSP would have blocked Modrinth and Hangar icons.
  - Notifications could be posted out of order.
  - Phones: long IPv6 addresses, the cloud accounts buttons, and screen-reader labels inside scrolling tables (absolutely positioned, so they widened the whole page) made pages scroll sideways. A per-tab phone check is now part of the e2e suite.
  - Linux archives made on Windows lost the executable bits and made every file world-writable. The build now writes the tar itself with 0755/0644.
  - The checklist waited for a full security report (router and firewall checks); it now uses the last score.
- **Not done:**
  - Nothing is published: no registry image, no npm package (`cubehold` is still free on npm), and an unsigned installer (SmartScreen warns).
  - macOS untested; Intel Macs unsupported (no argon2 prebuild).
  - Old Forge (below 1.17, jar launch) not tested live; the linux-arm64 and macOS archives are built but were not run.
  - CurseForge and Quilt packs.
  - Provider adapters against recorded HTTP fixtures (no accounts to record from).
  - Docker Desktop on Windows/macOS (host networking).
  - `CUBEHOLD_MASTER_KEY` cannot work (the master key is random and never shown), so stored credentials stay locked after a reboot until the owner logs in. That delays playit.gg tunnels after a Windows restart. Proposed: auto-unlock through Windows DPAPI or an owner-chosen key file.

---

## Critical files (to be created)

- `apps/server/src/index.ts` — Fastify boot, tRPC + WS mount, scheduler start.
- `apps/server/src/db/schema.ts` — Drizzle schema (tables above).
- `apps/server/src/hosts/driver.ts` — `HostDriver` interface; `local.ts`, `ssh.ts` implementations.
- `apps/server/src/security/crypto.ts` — argon2id key derivation, AES-256-GCM credential store.
- `apps/agent/src/supervisor.ts` — MC process lifecycle and console stream.
- `apps/agent/src/rpc.ts` — JSON-RPC over WebSocket server.
- `packages/mc/src/versions/*.ts` — per-software version fetchers; `java.ts` matrix + Adoptium.
- `packages/mc/src/properties.ts` — `server.properties` schema.
- `packages/providers/src/provider.ts` — `CloudProvider` interface; `hetzner/`, `aws/`, ... adapters.
- `packages/tunnels/src/playit.ts`, `upnp.ts`.
- `apps/web/src/routes/servers/$id/{overview,console,players,files,settings,plugins,backups,schedules}.tsx`.

---

## Verification

- **M0:** `pnpm dev` starts API on :4000 and web on :5173; owner setup + login works; `pnpm test` and `pnpm lint` pass.
- **M1:** Create a Paper 1.21.x server on this Windows machine with no Java preinstalled; it downloads JDK 21 and the jar, accepts EULA, starts, prints "Done" in the live console, `say hello` from the console appears in the log, a real Minecraft client on `localhost:25565` can join, CPU/RAM chart updates, stop returns to "stopped" cleanly.
- **M2:** Kick/whitelist a player from the UI; edit `server.properties` and see it applied after restart; create and restore a backup; a scheduled restart fires; kill `java` externally and see crash detected + auto-restart; install a plugin from Modrinth and see it load; idle auto-stop triggers and join wakes it.
- **M3:** With playit.gg configured, a friend outside the LAN joins via the public address; security score reflects toggles.
- **M4:** Point at a fresh Ubuntu VPS by IP + key; agent installs and server runs there with the same dashboard; migrate the local server to it.
- **M5:** With a Hetzner token, provision a VM, server starts, cost meter shows expected rate, idle stop shuts the VM down and join wakes it; repeat for AWS.
- **M6:** Docker image runs the panel end to end; Playwright suite green. Done: see the M6 section.

---

## Assumptions / open points

- Name: **cubehold**, always written in lowercase (chosen 2026-10-03). The earlier working name was dropped because it is the usual abbreviation of MCSManager, an established open-source Minecraft panel. cubehold was free on npm and had no Minecraft project of the same name at the time.
- CurseForge browsing needs a user-supplied API key (their ToS); Modrinth and Hangar are open.
- Bedrock Dedicated Server support is planned via Geyser first; native BDS hosting is a later addition.
