# cubehold on Linux (without Docker)

Docker is the easiest way to run cubehold on Linux (see the project README). To run it
directly instead, as two systemd services:

```sh
sudo tar -xzf cubehold-VERSION-linux-x64.tar.gz -C /opt
sudo mv /opt/cubehold-VERSION-linux-x64 /opt/cubehold
sudo useradd --system --home-dir /var/lib/cubehold --create-home --shell /usr/sbin/nologin cubehold
sudo cp /opt/cubehold/extras/cubehold-agent.service /opt/cubehold/extras/cubehold.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cubehold-agent cubehold
```

The panel listens on 127.0.0.1:4000. From your computer: `ssh -L 4000:127.0.0.1:4000 you@server`,
then open http://127.0.0.1:4000. To open it to your network instead, set `HOST=0.0.0.0` in
`cubehold.service` (plain HTTP: put a reverse proxy with HTTPS in front before exposing it to the internet).

Minecraft servers need their ports open in your firewall (for example `sudo ufw allow 25565/tcp`).

Commands: `/opt/cubehold/cubehold --help`. Updating: stop both services, replace /opt/cubehold, start them.
Your data stays in /var/lib/cubehold.

For a quick try without services, run `./cubehold` from the unpacked folder. It keeps data in
~/.local/share/cubehold and starts the agent in the background by itself.
