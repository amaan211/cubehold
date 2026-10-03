<p align="center">
  <img src="docs/public/logo.svg" alt="cubehold logo: a white cube on a green rounded square" width="112">
</p>

<h1 align="center">cubehold</h1>

<p align="center">
  Run Minecraft servers on your own computer, a cheap VPS, or your own cloud account,<br>
  and manage them all from one panel in your browser.
</p>

cubehold works like a hosting company's control panel (think exaroton or Aternos), but your servers
run on machines you own or rent. There is no account with us and no subscription.

## Features

- **Any machine**: this computer, any Ubuntu or Debian VPS (set up for you over SSH), or VMs it
  creates in your Hetzner, DigitalOcean, Vultr, Linode or AWS account.
- **Popular server software**: Paper, Purpur, Vanilla, Fabric, NeoForge and Forge, plus Modrinth
  modpacks. Java downloads by itself.
- **A full dashboard**: live console, players and their inventories, files, plugins and mods,
  backups, schedules, and crash explanations in plain words.
- **Friends can join from anywhere**: playit.gg, router port forwarding, Tailscale, ngrok or
  Cloudflare Tunnel, with a test from the internet.
- **Safe by default**: a security score with one-click fixes, and a firewall that only opens your
  game ports.
- **Cheaper cloud servers**: what each VM costs, and the VM switches off while nobody plays.
- **Servers keep running** when the panel is closed or updated.
- Discord notifications, a phone layout, and a getting-started checklist.

## Install

| Platform | How |
| --- | --- |
| Windows 10/11 | `cubehold-setup-<version>.exe`, a per-user installer with a tray app ([guide](docs/guide/install-windows.md)) |
| Linux with Docker | `docker compose -f docker/compose.yaml up -d --build` ([guide](docs/guide/install-docker.md)) |
| Linux | `cubehold-<version>-linux-x64.tar.gz` with systemd services ([guide](docs/guide/install-linux.md)) |

No release is published yet: build the files with `pnpm dist` (see [Development](#development)).

## Documentation

Everything else is in the [documentation](docs/guide/what-is-cubehold.md): your
[first server](docs/guide/first-server.md), [letting friends join](docs/guide/friends.md),
[VPS](docs/guide/vps.md) and [cloud](docs/guide/cloud.md) servers,
[modpacks](docs/guide/modpacks.md), [security](docs/guide/security.md),
[troubleshooting](docs/guide/troubleshooting.md) and more. `pnpm docs` shows it as a website.

## Development

```sh
pnpm install
pnpm dev     # API on http://127.0.0.1:4000, web app on http://localhost:5173
```

Needs Node.js 24 and pnpm 12. Tests, release builds and the code layout are in
[docs/reference/development.md](docs/reference/development.md).
