# Troubleshooting

## The server crashed

The **Overview** shows a crash card: what went wrong in plain words, a hint, and plugins or mods
that appear in the error. **Crash reports** opens the full report. Common causes:

- **Out of memory**: raise the memory in Settings, or remove heavy mods.
- **Port in use**: another server or program uses the port. Change it in Settings.
- **Wrong Java**: happens with old mods; the version change screen picks the right Java for the
  Minecraft version.
- **A mod or plugin**: the crash card names suspects. Disable them in the Mods or Plugins tab
  (with the server stopped on Windows).

## Friends cannot join

Use **Network → Test from the internet**. It tells you why a connection failed:

- **Firewall**: see [Security → Windows Firewall](./security#windows-firewall).
- **CGNAT or two routers**: port forwarding cannot work; use playit.gg.
- **VPN on this computer**: the public address is the VPN's; use playit.gg or turn the VPN off.
- **Wrong version**: players need the server's Minecraft version (or ViaVersion on the server).
- **Whitelist**: add them in the Players tab.

## The panel does not open

- **Windows**: check that the green cubehold icon is in the notification area. If it says "cubehold
  stopped", choose **Open log**. "Port 4000 is used by another program" means you should set
  another `PORT` in `%LOCALAPPDATA%\cubehold\launcher.env`.
- **Docker**: `docker compose -f docker/compose.yaml logs panel`.
- **Linux service**: `journalctl -u cubehold -e`.
- **macOS**: look at the Terminal window that runs `~/cubehold/cubehold`, or start it again there.

## "The credential store is locked"

After the panel restarts, cloud tokens, SSH keys and tunnel keys stay encrypted until you log in.
Log in (or use the unlock banner) and VPS hosts, cloud hosts and playit.gg tunnels continue.

## I forgot my password

There is no reset by email: cubehold has no account with us. Your servers and worlds are safe in the
data folder. Stored credentials (cloud tokens, SSH keys) are encrypted with the password and
cannot be recovered without it.

## Getting the logs

| What | Windows | Docker | Linux service | macOS |
| --- | --- | --- | --- | --- |
| Panel | `%LOCALAPPDATA%\cubehold\logs\panel.log` | `logs panel` | `journalctl -u cubehold` | its Terminal window |
| Agent | `%LOCALAPPDATA%\cubehold\agent.log` | `logs agent` | `journalctl -u cubehold-agent` | `~/Library/Application Support/cubehold/agent.log` |
| A server | Files tab → `logs/latest.log` | same | same | same |
