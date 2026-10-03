# Install on macOS

cubehold runs on Macs with Apple silicon (M1 or newer). Intel Macs are not supported, because one
of the libraries cubehold needs has no Intel Mac build.

::: warning New
macOS support is new and has had little testing. If something goes wrong, please report it on
GitHub.
:::

## Install

1. Download `cubehold-VERSION-darwin-arm64.tar.gz` from the
   [releases page](https://github.com/amaan211/cubehold/releases).
2. In Terminal, unpack it and move it to your home folder:

   ```sh
   cd ~/Downloads
   tar -xzf cubehold-VERSION-darwin-arm64.tar.gz
   mv cubehold-VERSION-darwin-arm64 ~/cubehold
   xattr -dr com.apple.quarantine ~/cubehold
   ```

   The last line removes the "downloaded from the internet" mark. Some files cubehold loads are
   not signed by Apple, and macOS would otherwise refuse to open them.

3. Start it:

   ```sh
   ~/cubehold/cubehold
   ```

4. Open <http://127.0.0.1:4000> and create the owner account.

## Where things are

| What | Where |
| --- | --- |
| The program | the folder you moved, for example `~/cubehold` |
| Your data (servers, worlds, backups, settings) | `~/Library/Application Support/cubehold` |
| The panel's log | the Terminal window it runs in |
| The agent's log | `~/Library/Application Support/cubehold/agent.log` |

## Keeping it running

Your Minecraft servers run in a background agent, which keeps going when you close Terminal. The
panel stops with its Terminal window; start it again with `~/cubehold/cubehold` whenever you want
to manage your servers.

To stop the servers and the agent: `~/cubehold/cubehold agent stop`.

### Start the panel at login (optional)

This setup has not been tested on a real Mac yet. Start cubehold by hand once first, so its data
folder exists. Then save this as `~/Library/LaunchAgents/com.cubehold.panel.plist`, replacing
`YOU` with your macOS user name:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.cubehold.panel</string>
  <key>ProgramArguments</key>
  <array><string>/Users/YOU/cubehold/cubehold</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>/Users/YOU/Library/Application Support/cubehold/panel.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/Library/Application Support/cubehold/panel.log</string>
</dict>
</plist>
```

Load it with `launchctl load ~/Library/LaunchAgents/com.cubehold.panel.plist`. The panel's log is
then `~/Library/Application Support/cubehold/panel.log`. To stop starting it at login, run
`launchctl unload` on the same file and delete it.

## The macOS firewall

If the macOS firewall is on, macOS asks whether `java` may accept incoming network connections the
first time a server starts. Choose **Allow**, or friends cannot join.

## Letting friends join from a Mac

playit.gg only makes its agent for Windows and Linux, so it cannot run on a Mac. Use router port
forwarding, Tailscale or ngrok from the server's **Network** tab, or run the server on a VPS. See
[Letting friends join](./friends).

## Updating

1. Stop the panel (Ctrl+C in its Terminal window, or `launchctl unload` if it starts at login).
2. Replace `~/cubehold` with the new version, then run the `xattr` line from the install steps
   again.
3. Start the panel again.

Running servers keep going during the update. The new panel switches the agent to the new version
once no server is running. Your data stays in `~/Library/Application Support/cubehold`.

## Uninstalling

Run `~/cubehold/cubehold agent stop`, then delete `~/cubehold` (and the `.plist` file if you made
one). Your worlds stay in `~/Library/Application Support/cubehold`; delete that folder too if you
do not want to keep them.
