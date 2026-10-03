# Install on Linux

[Docker](./install-docker) is the simplest way to run cubehold on Linux. If you prefer not to use
Docker, the Linux archive contains everything cubehold needs, including its own Node.js.

Archives exist for x86_64 (`linux-x64`) and ARM64 (`linux-arm64`, for example a Raspberry Pi 4
or 5 with a 64-bit system). They need glibc, which Ubuntu, Debian, Fedora and most other
distributions have (Alpine does not).

## Try it

```sh
tar -xzf cubehold-VERSION-linux-x64.tar.gz
cd cubehold-VERSION-linux-x64
./cubehold
```

Open <http://127.0.0.1:4000>. Data goes to `~/.local/share/cubehold`. The agent keeps running in the
background after you stop `./cubehold`; `./cubehold agent stop` stops it and its servers.

## Run it as a service

To start cubehold at boot, run it as two systemd services under its own account:

```sh
sudo tar -xzf cubehold-VERSION-linux-x64.tar.gz -C /opt
sudo mv /opt/cubehold-VERSION-linux-x64 /opt/cubehold
sudo useradd --system --home-dir /var/lib/cubehold --create-home --shell /usr/sbin/nologin cubehold
sudo cp /opt/cubehold/extras/cubehold-agent.service /opt/cubehold/extras/cubehold.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cubehold-agent cubehold
```

- `cubehold-agent` runs the Minecraft servers and gives them 3 minutes to save when it stops.
- `cubehold` is the panel. It listens on `127.0.0.1:4000` only. To reach it from your computer:
  `ssh -L 4000:127.0.0.1:4000 you@server`, then open <http://127.0.0.1:4000>. To open it to your
  network, set `Environment=HOST=0.0.0.0` in `cubehold.service` (see
  [Keep the panel private](./install-docker#keep-the-panel-private)).
- Data lives in `/var/lib/cubehold`.

Open the game ports in your firewall, for example `sudo ufw allow 25565/tcp`.

## Updating

Stop both services, replace `/opt/cubehold` with the new version, start them again. Data in
`/var/lib/cubehold` is kept.

## macOS

See [Install on macOS](./install-macos).
