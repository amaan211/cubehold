# Modpacks, mods and plugins

## Which software?

| Software | For |
| --- | --- |
| **Paper** / **Purpur** | Plugins (Bukkit, Spigot, Paper). Vanilla gameplay, faster. |
| **Fabric** | Fabric mods, lightweight. |
| **NeoForge** | Most new modpacks and mods (Minecraft 1.20.2 and newer). |
| **Forge** | Forge mods and older modpacks (Minecraft 1.12.2 and newer). |
| **Vanilla** | Mojang's own server, no add-ons. |

For NeoForge and Forge, cubehold runs the official installer, which downloads Minecraft and the
loader's libraries (around 100 MB). The first install takes a minute or two.

## Install a modpack

1. **New server → Install a modpack instead**.
2. Search Modrinth, or **Upload .mrpack** for a pack file you have.
3. Pick the pack's version. The newest is usually right.
4. Check what the pack needs: Minecraft version, loader, number of server mods, and the download
   size. cubehold suggests memory from the number of mods; big packs want 6 to 10 GB.
5. Choose the host, name, port and login mode, accept the EULA, and press **Install modpack**.

cubehold then:

- installs the exact loader version the pack names,
- downloads every mod the server needs, each checked against the pack's checksum (mods marked
  client-only are left out),
- copies the pack's configuration files over the server,
- applies the pack's `server.properties` settings, except the port, login mode, RCON, query and
  whitelist, which stay as you set them.

If something fails, the console says what; press **Start** to try the install again.

Only Modrinth packs (`.mrpack`) are supported. CurseForge packs are not yet; many popular packs
are on both.

::: tip Players need the pack too
Your players install the same pack in their launcher (the Modrinth App, Prism Launcher or
ATLauncher can install Modrinth packs), in the same version.
:::

## Plugins and mods

A server's **Plugins** tab (Paper, Purpur) or **Mods** tab (Fabric, NeoForge, Forge) searches
Modrinth, and Hangar for plugins, showing only what fits the server's version and loader.
Install adds required dependencies too. Updates, disabling and removing are there as well.

On Windows, a running server keeps its jars open, so disabling, updating or removing needs the
server stopped. Installing works any time.
