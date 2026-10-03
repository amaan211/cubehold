# Commands and settings

## The `cubehold` command

| Command | What it does |
| --- | --- |
| `cubehold` | Run the panel. |
| `cubehold agent` | Run the agent in the foreground, for a service manager (Docker, systemd). |
| `cubehold agent status` | Whether the agent runs and which servers it hosts. `--json` for scripts. |
| `cubehold agent stop` | Stop every server gracefully (worlds are saved), then the agent. |
| `cubehold --version` | The version. |

How to run it:

- **Windows**: `%LOCALAPPDATA%\Programs\cubehold\app-<version>\cubehold.cmd`
- **Linux archive**: `./cubehold` in the unpacked folder, or `/opt/cubehold/cubehold`
- **Docker**: `docker compose -f docker/compose.yaml exec panel node /app/server.mjs <command>`

Commands that talk to the agent need the same `DATA_DIR` as the panel.

## Settings (environment variables)

On Windows, put these in `%LOCALAPPDATA%\cubehold\launcher.env`. With Docker, use `environment:` in the
compose file. For the Linux services, use `Environment=` lines in the unit files.

| Setting | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4000` | The panel's port. |
| `HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Which address the panel listens on. `0.0.0.0` lets other devices reach it. |
| `DATA_DIR` | Windows `%LOCALAPPDATA%\cubehold`, Linux `~/.local/share/cubehold`, macOS `~/Library/Application Support/cubehold`, Docker `/data` | Where the database, servers, backups and Java live. |
| `SECURE_COOKIES` | `false` | Set to `true` when the panel is served over HTTPS. |
| `CUBEHOLD_AGENT` | `daemon` | `daemon`: the panel starts the agent itself. `external`: a service manager runs it (Docker, systemd); the panel only connects. |
| `CUBEHOLD_AGENT_HOST` | `127.0.0.1` | With `CUBEHOLD_AGENT=external`, where the agent listens. |

## Ports

| Port | Used by |
| --- | --- |
| 4000/tcp | The panel |
| 25565/tcp and up | Minecraft servers (one each) |
| 25575/tcp and up | RCON, used by the panel on the same machine. Never forward it. |
| 19132/udp and up | Bedrock players through Geyser (one per server) |

## Data folder

| Path | Contents |
| --- | --- |
| `cubehold.db` | Settings, servers, schedules, history, encrypted credentials |
| `servers/<id>/` | Each server's files and world |
| `backups/<id>/` | Backups and version-change snapshots |
| `java/` | Java runtimes, shared by servers that need the same version |
| `agent.json` | How the panel finds the agent (secret: do not share) |
| `logs/` | The Windows app's panel log |
