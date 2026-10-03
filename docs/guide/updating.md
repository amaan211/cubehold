# Updating and uninstalling

## Windows

**Update**: run the newer `cubehold-setup-<version>.exe`. It closes the tray app and installs the new
version next to the old one. **Servers keep running during the update**: the agent that runs them
stays on the old version until the last server stops, then the panel switches it to the new
version by itself. The old version's files are removed afterwards.

**Uninstall**: Windows Settings → Apps → cubehold → Uninstall. It saves your worlds and stops every
server first, then removes the program, its Start menu entry and the sign-in autostart. It then
asks whether to delete your data too (servers, worlds, backups, settings in
`%LOCALAPPDATA%\cubehold`). The answer defaults to **No**, so a reinstall picks everything up again.

## macOS

Stop the panel, replace the program folder with the new version, run the `xattr` line from
[Install on macOS](./install-macos) again, and start it. Running servers keep going; the agent
switches to the new version once none is running.

## Docker

```sh
docker compose -f docker/compose.yaml up -d --build
```

The containers are recreated: servers save and stop, then start again if you start them. Data
stays in the `cubehold_data` volume.

## Linux services

Stop `cubehold` and `cubehold-agent`, replace `/opt/cubehold` with the new version, start them again. Data in
`/var/lib/cubehold` is kept.

## VPS and cloud hosts

The agent on each VPS updates itself to the panel's version when no server is running on it.
Otherwise the host card offers **Update agent**.

## Moving cubehold to another computer

1. Stop every server, then quit cubehold (or stop the containers/services).
2. Copy the data folder to the new machine's data folder: `%LOCALAPPDATA%\cubehold` on Windows, the
   `cubehold_data` volume with Docker, `/var/lib/cubehold` for the Linux service.
3. Start cubehold there and log in with the same password.

Servers on VPS and cloud hosts come along automatically: they are managed over SSH from whichever
computer runs the panel.
