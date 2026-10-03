# Install with Docker

Docker is the easiest way to run cubehold on a Linux machine: a home server, a NAS that runs Docker,
or a VPS you manage yourself.

It runs as two containers from the same image:

- **agent** runs the Minecraft servers,
- **panel** is the web app.

Restarting or updating the panel never stops a server.

::: warning Linux only
The containers use the host's network, so Minecraft servers get their ports without mapping each
one and router port forwarding (UPnP) works. Docker Desktop on Windows and macOS does not provide
this. On Windows, use the [Windows app](./install-windows) instead.
:::

## Start it

You need Docker with the Compose plugin (`docker compose version` should work). From a copy of
the cubehold source:

```sh
docker compose -f docker/compose.yaml up -d --build
```

The first build takes a few minutes. Then open `http://<this machine's address>:4000` and create
the owner account.

## What the compose file sets up

- One volume, `cubehold_data`, mounted at `/data` in both containers. It holds the database,
  servers, worlds, backups and Java runtimes.
- `stop_grace_period: 3m` on the agent, so `docker compose down` gives servers time to save their
  worlds.
- The panel listens on port 4000 on all addresses (`HOST=0.0.0.0`).

## Keep the panel private

The panel speaks plain HTTP. On a home network that is usually fine. Before you open it to the
internet, put it behind a reverse proxy with HTTPS (Caddy, nginx, Traefik) and set
`SECURE_COOKIES: "true"` in the panel's `environment:`. Alternatively use Tailscale and keep the
panel off the internet.

## Common tasks

```sh
docker compose -f docker/compose.yaml logs -f panel    # the panel's log
docker compose -f docker/compose.yaml logs -f agent    # the agent and server output
docker compose -f docker/compose.yaml exec panel node /app/server.mjs agent status
docker compose -f docker/compose.yaml down             # stop (servers save first)
```

## Updating

Get the new source, then:

```sh
docker compose -f docker/compose.yaml up -d --build
```

Both containers are recreated, so running servers stop (and save) while the agent restarts.

## Backing up cubehold itself

Everything is in the `cubehold_data` volume. Stop the stack, then copy the volume, for example:

```sh
docker run --rm -v cubehold_data:/data -v "$PWD":/backup busybox tar czf /backup/cubehold-data.tgz -C /data .
```

(`docker volume ls` lists it.)
