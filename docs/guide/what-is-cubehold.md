# What is cubehold?

cubehold is a Minecraft server manager that you run yourself. It works like a hosting company's
control panel (think exaroton or Aternos), but the servers run on machines you own or rent:

- **This computer.** Good for playing with friends while your PC is on. No rental costs.
- **A VPS**: a small rented Linux server (from about €4 a month) that stays online when your
  computer is off. cubehold sets it up over SSH in a few minutes.
- **A cloud VM** in your own Hetzner, DigitalOcean, Vultr, Linode or AWS account. cubehold creates
  it, and can switch it off while nobody plays so you only pay for play time. A cost page shows what
  you pay and why, and one button deletes everything cubehold made in the cloud.

You open the panel in a browser and manage every server the same way, wherever it runs.

## What you get

| Area | What it does |
| --- | --- |
| Servers | Paper, Purpur, Vanilla, Fabric, NeoForge and Forge. Java and the server files download by themselves. |
| Console | The live server console with command history. |
| Players | Who is online, whitelist, ops, bans, playtime history, and each player's inventory drawn like the game. |
| Files | Browse and edit files, upload and download, zip and unzip. |
| Plugins and mods | Search Modrinth and Hangar, install with dependencies, update and remove. |
| Modpacks | Install Modrinth modpacks in a few clicks. |
| Backups | Backups while the server runs, restore, and schedules. |
| Network | Every address players can use, tunnels, router forwarding, and a test from the internet. |
| Security | A score with the checks that matter for a home server, and fixes. |
| Automation | Restart after crashes, stop when empty, start when someone joins. |
| Notifications | Messages in a Discord channel when servers start, stop, crash, or players join. |

## How it is built

cubehold has two parts:

- **The panel**: the web app and its API. It stores your settings and encrypted credentials.
- **The agent**: a small background program on each machine that runs Minecraft. The panel
  talks to it (on a VPS, only through SSH).

Because the agent runs the servers, **closing or updating the panel does not stop your
servers**. Automation (crash restarts, idle stop, wake on join) also keeps working without the
panel.

## What you need

- Windows 10 or 11, a Mac with Apple silicon, or a Linux machine (with or without Docker).
- Nothing else. Java is downloaded for you, in the version each Minecraft release needs.
- For servers that friends join from elsewhere: see [Letting friends join](./friends).

Next: install it on [Windows](./install-windows), with [Docker](./install-docker), on
[Linux](./install-linux) or on [macOS](./install-macos).
