# cubehold

A self-hosted, multi-cloud Minecraft server manager. Like exaroton or Aternos, except it runs on
**your** infrastructure: your AWS/GCP/Azure/Hetzner/Linode account, a cheap VPS it helps you pick,
or the machine you are sitting at (with tunnelling so friends can join).

See [plan.md](./plan.md) for the roadmap and architecture, and [docs/](./docs) for the user
documentation (`pnpm docs` to read it as a website).

## Install

- **Windows**: `cubehold-setup-<version>.exe`, a per-user installer (no admin) with a tray app and
  an optional start at sign-in. See [docs/guide/install-windows.md](./docs/guide/install-windows.md).
- **Linux with Docker**: `docker compose -f docker/compose.yaml up -d --build`, then open port
  4000. See [docs/guide/install-docker.md](./docs/guide/install-docker.md).
- **Linux without Docker**: `cubehold-<version>-linux-x64.tar.gz` (or `linux-arm64`) with systemd
  units. See [docs/guide/install-linux.md](./docs/guide/install-linux.md).

Release files are built with `pnpm dist` (see [Building releases](#building-releases)); nothing is
published anywhere yet.

## Status

Milestones 0 to 6 are complete. You can create Paper, Purpur, Vanilla, Fabric, NeoForge or Forge
servers, or install a Modrinth modpack, on this machine, on any Ubuntu/Debian VPS you add, or on a
VM the panel creates in your Hetzner, DigitalOcean, Vultr, Linode or AWS account. Java and the
server files download automatically on whichever machine runs the server. Each server has:

- **Overview**: CPU, memory (Java process and heap in use), TPS and tick time, players, and a
  crash card that explains the last crash.
- **Console** with command history.
- **Players**: who is online, op/kick/ban, whitelist, bans (players and IPs), and a history of
  everyone who ever joined with playtime and deaths. Works while the server is stopped too.
  Click a name for the **player page**: health, hunger and XP (live while online) with kill,
  starve, heal and feed; their inventory and ender chest drawn like the game, with tooltips;
  position, respawn point and last death with teleport; whitelist/ban/op switches, game mode,
  give item, clear inventory, kick and message; and their statistics.
- **Files**: browse, edit with syntax highlighting, upload (drag and drop), download files or
  folders as zip, compress and extract.
- **Plugins / Mods**: search Modrinth and Hangar filtered to the server's version and loader,
  install with dependencies, update, disable, remove.
- **Backups**: zip backups while the server keeps running, restore (with a safety backup first),
  download, and retention for automatic backups.
- **Schedules**: restart, stop, start, backup, command or chat message on a timetable, with
  in-game warnings before restarts.
- **Network**: every address players can use (same network, public address, playit.gg,
  ngrok, Tailscale, Cloudflare Tunnel). Features:
  - playit.gg tunnels that work behind any router or provider.
  - ngrok, Tailscale (private sharing, or public through Funnel) and Cloudflare Tunnel, each
    set up from the Network tab: paste a token or sign in, and the panel downloads, checks and
    runs the program.
  - Automatic router port forwarding (UPnP).
  - A "test from the internet" button that works even while the server is stopped.
  - A Windows Firewall check with a fix.
  - Bedrock players (phones, consoles) through Geyser and Floodgate.
- **Security**: a score with the checks that matter for a home server, each with a fix where the
  panel can apply one. Checks cover offline mode, the whitelist, BungeeCord spoofing, RCON, query,
  the firewall, Log4Shell, old versions, block logging and panel access. There is also a
  "Harden this server" button and recommended plugins (CoreProtect, LuckPerms, Ledger).
- **Settings**: name, memory, port, JVM arguments, automation, Discord notifications, version
  changes, player login, and a typed `server.properties` editor.

**Modpacks** (M6): search Modrinth or upload a `.mrpack`. The panel installs the pack's exact
Fabric, NeoForge or Forge version, downloads every server mod on the host (each checked against
the pack's hash, client-only mods left out), copies the pack's configs, and applies its
`server.properties` except the port, login mode, RCON, query and whitelist.

**Discord** (M6): a webhook per server for starts and stops, crashes (with the explanation), joins
and leaves, backups and cloud VM power. Only changes the panel sees are posted, never the state of
every server again after a restart, and messages can never mention anyone.

**Phone** (M6): the panel fits a phone, with a bottom navigation bar, and installs to the home
screen (manifest, icons, an offline page over HTTPS). Settings explains how to reach it from a
phone (LAN, or Tailscale with HTTPS). The Servers page has a getting-started checklist that ticks
itself off.

**Hosts** (M4): add a VPS by IP address and root password (or a key and a sudo user). The panel
logs in once, checks the machine, installs its own SSH key, Node.js and the agent (a systemd
service running as its own `cubehold` account), and turns on the firewall, fail2ban and automatic
security updates. After that it reaches the agent only through SSH, reconnects by itself, keeps
the agent updated, and opens game ports in the firewall as servers come and go. Any server can
be **moved** between this computer and a VPS (or between two VPSes) with its world, history and
backups. "Getting a VPS" on the Hosts page suggests a size and compares providers.

**Cloud** (M5): connect a Hetzner, DigitalOcean, Vultr, Linode or AWS account (the Hosts page
shows exactly how to make the token, and the IAM policy for AWS), then create a cloud server:
pick a location and a size (with the provider's prices and a size suggestion), and the panel
creates the VM, its firewall and SSH key, and sets it up like any VPS. Host cards show what the
VM has cost this month. Each server can turn its VM off once nobody plays: AWS stops the VM
(only the disk is billed); the other providers bill a stopped VM in full, so the VM is saved as
a snapshot and deleted instead, and restored when you press Start (2 to 5 minutes).

Automation runs in the agent, so it keeps working with the panel closed: restart after a crash
(3 tries in 10 minutes), stop after N minutes with nobody online, and wake on join (the server
shows as sleeping in the server list and starts when someone connects).

## Requirements

- Node 24 LTS
- pnpm 12 (`npm install -g pnpm`)

Java is not required. The panel downloads the right Eclipse Temurin runtime per Minecraft version.

## Development

```sh
pnpm install
pnpm dev          # API on http://127.0.0.1:4000, web on http://localhost:5173
```

Open http://localhost:5173, create the owner account, and you are in.

## Servers keep running when the panel stops

Minecraft processes are owned by a small background agent, not by the panel. Stopping `pnpm dev`,
a code reload, or a panel crash leaves your servers running; the panel picks them back up when it
starts again. To stop everything:

```sh
pnpm agent:status   # is the agent running, and which servers does it host?
pnpm agent:stop     # stop all servers gracefully (world saved), then the agent
```

An agent with no running servers and no panel connected exits by itself after 10 minutes.

## Versions, login and deleting

- **Change version** in a server's Settings tab, up or down. The panel downloads the right jar and
  Java runtime in the background, snapshots the world first (tagged with the version that saved
  it), and restarts the server if it was running. Downgrades can restore the world saved on the
  target version, keep the current world, or start fresh.
- **Player login**: one switch, at creation or in Settings, turns Microsoft/Mojang authentication
  on or off (`online-mode` and `enforce-secure-profile`).
- **Delete** removes the server folder, its world snapshots, and any Java runtime no other server
  uses. You can first copy worlds, plugins/mods, settings, logs or snapshots to a folder of your
  choice; the copy is verified before anything is deleted.

Java runtimes are shared between servers that need the same version and are removed when the last
one that needs them is deleted or moved to another version.

## Good to know

- **Memory**: the memory setting is the Java heap. The process uses more than that (roughly 300 MB
  plus 10% of the heap for Java itself), and it reserves the whole heap at start. The Overview
  shows both the process size and how much of the heap is really in use.
- **RCON**: the panel turns on RCON with a random 64-character password and a free port starting
  at 25575, for replies to player actions, TPS and the player list. Vanilla Minecraft cannot bind
  RCON to localhost only, so do not forward the RCON port on your router.
- **Plugins on Windows**: a running server keeps its jars open, so disabling, updating or removing
  plugins and mods needs the server stopped. Installing new ones works any time.
- **Schedules** run inside the panel, in this machine's time zone. A schedule due while the panel
  is closed is skipped, not run late. Crash restarts and idle stop/wake do not need the panel.
- **Backups** live in `data/backups/<server>/archives` next to the version-change snapshots and
  are deleted with the server (the delete dialog can export them first).
- **Inventories** are drawn with the game's own textures. The first time you open a player on a
  Minecraft version, the panel downloads that version's client from Mojang (about 25 MB) and
  keeps only the textures, models and English names (about 2 MB, in `data/assets/<version>`).
  They are removed when no server uses that version any more.
- **Live player data**: health, hunger, XP and position are read live. Paper shortens long
  `/data get` output, so the inventory comes from the player's saved file; opening a player page
  asks the server to save (at most every 30 seconds, or on Refresh).
- **playit.gg**: link your account once, on the Hosts page or a server's Network tab.
  - The panel downloads playit's official agent (checked against the SHA-256 GitHub records)
    and runs it in the background, so tunnels keep working with the panel closed.
  - playit.gg does not let an agent create tunnels itself. You add the tunnel on playit.gg (the
    Network tab shows exactly what to enter) and its address appears in the panel.
  - The agent's key is stored encrypted with your password, so after a reboot the tunnel starts
    when you log in.
- **ngrok**:
  - Needs a free ngrok account with a card on file; ngrok requires it for TCP addresses and
    does not charge it.
  - One ngrok process carries every shared server, since free accounts allow one connection.
  - Addresses change whenever ngrok restarts. Java Edition only (ngrok carries no UDP).
- **Tailscale**: the panel detects Tailscale, starts the sign-in, and on Windows can install it
  (winget, with an administrator prompt).
  - Private sharing: friends who accept a shared machine join at its Tailscale name.
  - **Funnel** makes a server public on port 443, 8443 or 10000, with nothing to install for
    players.
- **Cloudflare Tunnel**: create the tunnel in the Cloudflare dashboard and paste its token; the
  panel runs cloudflared and shows which hostnames lead to which server.
  - Minecraft is raw TCP, which Cloudflare only passes to another cloudflared, so every player
    runs `cloudflared access tcp …` first. The Network tab has the commands per system.
- **Minecraft 26.1+ worlds** keep player files under `world/players/`. The panel reads either
  layout.
- **Port forwarding (UPnP)**: forwards are one-hour leases the agent renews every 20 minutes, so
  they close by themselves when the computer is off. The agent removes them when it stops.
  Routers that refuse timed forwards get permanent ones.
- **Windows Firewall**: when Java first starts, Windows asks whether to allow it.
  - "Allow" creates a rule that opens every port to Java, RCON included.
  - "Cancel" creates a block rule, and then nobody can connect.
  - The firewall fix (one administrator prompt) removes both kinds of rule and allows each
    server's game ports only.
- **Log4Shell**: vanilla and Fabric 1.7 to 1.16.5 get Mojang's log4j fix at every start; newer
  versions and Paper/Purpur builds are already safe.
- **Bedrock players**: each server gets its own UDP port, starting at 19132. Bedrock names start
  with a dot (`.Steve`) so they never clash with Java players. Paper and Purpur need 1.20.5 or
  newer; servers behind the newest Minecraft version also get ViaVersion.
- **VPS hosts**:
  - **Supported systems**: Ubuntu 22.04+ and Debian 12+, x86_64 or ARM64, with systemd.
  - **What goes where**: the agent lives in `/opt/cubehold`, with data (servers, backups, Java) in
    `/var/lib/cubehold`, and its settings in `/etc/cubehold/agent.env` (root only).
  - **The agent** listens on 127.0.0.1 only; the panel reaches it through SSH with its own key
    per host, stored encrypted like other credentials.
  - **After a panel restart**, VPS hosts stay locked until you log in again or unlock with your
    password from the banner. Servers keep running on the VPS meanwhile, and their automation
    (crash restarts, idle stop, wake on join) keeps working.
  - **Firewall**: the panel keeps ufw rules for game ports in sync. It opens nothing else;
    RCON stays closed.
  - **Provider firewalls**: AWS, Oracle and Google also filter traffic before it reaches the
    VPS. Open the game port there too (the Network tab says so when a test fails).
  - **Identity**: the panel pins each VPS's host key. If you reinstall the VPS, the card offers
    "Accept the new identity", which asks for the login again.
  - **Updating the agent**: remote agents update themselves to the panel's version when no
    server is running on them. Otherwise the host card shows "Update agent".
- **Cloud VMs**:
  - **Tokens**: account tokens are stored encrypted like other credentials. The panel only
    touches what it created: everything carries an `cubehold-…` tag, and the AWS policy only
    allows starting, stopping and deleting instances with that tag.
  - **Prices** come from the providers' APIs (AWS: its Price List API, or a US East estimate
    if the key may not read it). Costs on the host card are estimates from the time the VM spent
    running, stopped or saved; the provider's invoice is what counts.
  - **Addresses**: a VM restored from a snapshot, or an AWS VM started again, usually gets a new
    IP address. The panel follows it; players need the new address.
  - **The panel must be running** for an idle VM to be turned off, and to start it again.
  - **Deleting a cloud host** deletes the VM with its disk, its firewall, SSH key and snapshot.
    Move or delete its servers first.

## Other commands

```sh
pnpm typecheck    # tsc across all workspaces
pnpm lint         # biome
pnpm test         # vitest
pnpm e2e          # Playwright against build/app (run pnpm dist first); see e2e/playwright.config.ts
pnpm docs         # the documentation site at http://localhost:5180
pnpm db:generate  # regenerate drizzle migrations after editing apps/server/src/db/schema.ts
```

## Building releases

```sh
pnpm dist                      # build/app: server.mjs, agent.mjs, web/, drizzle/ (runnable: node build/app/server.mjs)
pnpm dist --target win-x64     # + Node.js and native modules: a zip and build/cubehold-setup-<version>.exe
pnpm dist --target linux-x64   # build/cubehold-<version>-linux-x64.tar.gz (also linux-arm64, darwin-arm64)
docker build -f docker/Dockerfile -t cubehold .
```

- The panel and the agent are bundled with esbuild; argon2 and libsql stay native modules,
  installed by npm for each target platform.
- Node.js comes from nodejs.org, checked against `SHASUMS256.txt`. The version is the one
  running the build.
- The Windows tray app (`packaging/windows/cubehold.cs`) is compiled with the C# compiler that
  ships with Windows, so it needs no SDK.
- The installer is built with Inno Setup, unpacked in portable mode from its official installer
  (signature checked) into `.cache/`. Nothing is installed on the build machine.
- The installer is not code-signed yet, so Windows SmartScreen warns on first run.

Configuration lives in environment variables; see [.env.example](./.env.example). Data (SQLite DB,
server files, downloaded Java, agent state and log) goes to `apps/server/data` under `pnpm dev`, or
wherever `DATA_DIR` points.

## Layout

```
apps/server         Fastify + tRPC API, SQLite via Drizzle, auth, realtime WebSocket
apps/web            React + Vite + Tailwind dashboard
apps/agent          Agent daemon that runs Minecraft processes (locally, and on each VPS)
packages/shared     zod schemas and types shared by everything
packages/mc         Version sources, Java download, launch flags, server.properties, log parser
packages/providers  Cloud provider adapters (milestone 5)
packages/tunnels    UPnP port forwarding, playit.gg API, reachability checks, Windows Firewall
packaging           Release build (pnpm dist), Windows tray app and installer, Linux units
docker              Dockerfile and compose file
e2e                 Playwright end-to-end tests
docs                The documentation site (VitePress)
```
