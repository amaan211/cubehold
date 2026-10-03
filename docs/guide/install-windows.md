# Install on Windows

cubehold for Windows is an app with a tray icon. It installs for your Windows account only and does
not need administrator rights.

## Install

1. Download `cubehold-setup-<version>.exe`.
2. Run it. Windows may show **"Windows protected your PC"** because the installer is not signed
   yet: choose **More info**, then **Run anyway**.
3. Leave **Start cubehold when I sign in** ticked if you want the panel to be there after a restart.
4. Finish. Your browser opens the panel at <http://127.0.0.1:4000>.
5. Create the owner account. Use a password you do not use elsewhere: it also protects the
   credentials cubehold stores (cloud tokens, SSH keys).

## The tray icon

cubehold lives in the notification area (next to the clock). Right-click the green icon:

| Item | What it does |
| --- | --- |
| **Open cubehold** | Opens the panel in your browser (double-clicking the icon does the same). |
| **Start when I sign in** | Starts cubehold in the background when you sign in to Windows. |
| **Open data folder** | Your servers, worlds, backups and settings. |
| **Open log** | The panel's log, for troubleshooting. |
| **Restart panel** | Restarts the panel. Servers keep running. |
| **Quit** | Stops the panel. If servers are running, cubehold asks whether to stop them too. |

If the panel crashes, the tray app restarts it. When Windows shuts down or you sign out, cubehold
saves your worlds and stops the servers first. Windows shows "Saving Minecraft worlds" while it
waits.

## Where things are

| What | Where |
| --- | --- |
| The program | `%LOCALAPPDATA%\Programs\cubehold` |
| Your data (servers, worlds, backups, settings) | `%LOCALAPPDATA%\cubehold` |
| The panel's log | `%LOCALAPPDATA%\cubehold\logs\panel.log` |
| Launcher settings | `%LOCALAPPDATA%\cubehold\launcher.env` |

## Launcher settings

`%LOCALAPPDATA%\cubehold\launcher.env` holds settings for the panel, one `NAME=value` per line.
Create it if it does not exist, then choose **Restart panel** in the tray menu.

```ini
# Use another port if 4000 is taken
PORT=4100
# Let other devices on your network open the panel (plain HTTP)
HOST=0.0.0.0
```

See [Commands and settings](/reference/cli) for everything you can set.

## Windows Firewall

The first time a Minecraft server starts, Windows asks whether Java may use the network. The
server's **Security** tab checks the firewall and has a **Fix** button that allows exactly the
game ports (one administrator prompt). See [Security](./security#windows-firewall).

## Updating and uninstalling

Run a newer installer over the old one. Servers keep running during the update. See
[Updating and uninstalling](./updating).
