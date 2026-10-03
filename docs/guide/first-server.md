# Your first server

## Create it

1. Press **New server**.
2. **Software**: Paper suits most people. It runs vanilla worlds and supports plugins. Pick
   Fabric, NeoForge or Forge for mods, or [install a modpack](./modpacks).
3. **Version**: the newest release is selected. Players need the same Minecraft version.
4. **Memory**: 2 to 4 GB suits a handful of players. Java needs a bit more than this on top, and
   the panel tells you how much.
5. **Port**: keep 25565 unless another server uses it.
6. **Player login**: leave online mode on so only real Minecraft accounts can join. Turn it off
   only for friends without a paid account or for LAN play.
7. Name it, accept the Minecraft EULA, and press **Create server**.

cubehold downloads the right Java and the server files. The console shows the progress; it takes a
minute or two the first time.

## Start it and join

Press **Start**. When the console says `Done`, the server is ready. The **Overview** tab shows the
**join address**:

- On the same network (your home Wi-Fi), use the address shown there, like `192.168.1.20`.
- On the computer that runs cubehold, `localhost` works too.
- For friends elsewhere, see [Letting friends join](./friends).

In Minecraft: **Multiplayer → Add Server**, paste the address, join.

## Getting around a server

| Tab | For |
| --- | --- |
| Overview | CPU, memory, TPS, players, the join address, crash explanations. |
| Console | Server output and commands (no `/` needed). |
| Players | Online players, whitelist, ops, bans, history, inventories. |
| Files | Configs, worlds and logs. |
| Plugins / Mods | Add-ons from Modrinth and Hangar. |
| Backups | Back up and restore. |
| Schedules | Restarts, backups and messages on a timetable. |
| Network | Addresses, tunnels, router forwarding, the internet test. |
| Security | The security score and fixes. |
| Settings | Name, memory, version, automation, Discord, `server.properties`. |

## Automation

In **Settings → Automation**:

- **Restart after a crash**: up to 3 times in 10 minutes.
- **Stop when nobody is online** after a number of minutes.
- **Wake on join**: a stopped server keeps answering in the server list as "sleeping" and starts
  when someone tries to join. They connect again once it has started.

These work even while the panel is closed.

## The getting started list

The **Servers** page shows a checklist that ticks itself off as you go: create a server, start
it, let friends join, check its security (ticked once its Security tab shows a score of 80 or
more), add nightly backups, and connect Discord. Hide it with the ✕; **Settings** brings it
back.
