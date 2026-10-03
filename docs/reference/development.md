# Development

How to run cubehold from source, test it, and build the release files.

## Requirements

- Node.js 24
- pnpm 12 (`npm install -g pnpm`)

Java is not needed: cubehold downloads the right runtime for each Minecraft version.

## Run from source

```sh
pnpm install
pnpm dev          # API on http://127.0.0.1:4000, web app on http://localhost:5173
```

Open `http://localhost:5173` and create the owner account. Data (database, servers, Java, agent
state and log) goes to `apps/server/data`, or wherever `DATA_DIR` points. Other settings are
environment variables; see `.env.example` and [Commands and settings](./cli).

Minecraft servers run in a background agent, not in the panel, so stopping `pnpm dev` or a code
reload leaves them running and the panel picks them up again. When the agent's code changes, the
panel replaces it as soon as no server is running on it.

```sh
pnpm agent:status   # is the agent running, and which servers does it host?
pnpm agent:stop     # stop every server gracefully (worlds saved), then the agent
```

## Checks

```sh
pnpm lint         # Biome
pnpm typecheck    # TypeScript in every package
pnpm test         # unit tests (Vitest)
pnpm e2e          # Playwright against build/app; run pnpm dist first
pnpm docs         # this documentation at http://localhost:5180
pnpm db:generate  # new migration after editing apps/server/src/db/schema.ts
```

`pnpm e2e` creates a real Paper server and a NeoForge modpack server, so it downloads Java and
server files. `CUBEHOLD_E2E_URL` points it at a panel that is already running (an install, or the
Docker stack); `CUBEHOLD_E2E_DATA` reuses a data folder between runs. See
`e2e/playwright.config.ts`.

## Build releases

```sh
pnpm dist                      # build/app: server.mjs, agent.mjs, web/, drizzle/ (node build/app/server.mjs runs it)
pnpm dist --target win-x64     # adds Node.js: a zip and build/cubehold-setup-<version>.exe
pnpm dist --target linux-x64   # build/cubehold-<version>-linux-x64.tar.gz (also linux-arm64, darwin-arm64)
docker build -f docker/Dockerfile -t cubehold .
```

- The panel and the agent are bundled with esbuild. argon2 and libsql stay native modules,
  installed by npm for each target platform.
- Node.js comes from nodejs.org, checked against `SHASUMS256.txt`, in the version running the
  build.
- The Windows tray app (`packaging/windows/cubehold.cs`) is compiled with the C# compiler that
  ships with Windows, so no SDK is needed.
- The installer is built with Inno Setup, unpacked in portable mode from its signed installer into
  `.cache/`. Nothing is installed on the build machine.
- The installer is not code-signed yet, so Windows SmartScreen warns on the first run.

## Logo and icons

The logo is drawn in `packaging/assets/icon.svg` (and `icon-maskable.svg` for phone launchers),
after the original artwork in `packaging/assets/logo-source.jpg`. After editing the SVGs, run
`pnpm icons`: it renders the favicon and phone icons, the docs logo, and the Windows `.ico` used by
the app, the installer and the tray.

## Layout

| Folder | Contents |
| --- | --- |
| `apps/server` | The panel: Fastify + tRPC API, SQLite through Drizzle, auth, realtime WebSocket |
| `apps/web` | The web app: React, Vite, Tailwind |
| `apps/agent` | The agent that runs Minecraft, on this computer and on each VPS |
| `packages/shared` | Schemas and types shared by everything |
| `packages/mc` | Minecraft knowledge: versions, Java, launch flags, `server.properties`, logs, modpacks |
| `packages/providers` | Cloud provider adapters |
| `packages/tunnels` | UPnP, playit.gg, reachability checks, Windows Firewall |
| `packaging` | Release build, Windows tray app and installer, Linux service files, icons |
| `docker` | Dockerfile and compose file |
| `e2e` | Playwright end-to-end tests |
| `docs` | This documentation (VitePress) |
