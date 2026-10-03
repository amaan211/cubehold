# Security

## The security score

Each server's **Security** tab lists the checks that matter for a server at home, each with the
reason and, where cubehold can do it, a **Fix** button:

- **Online mode**: only real Minecraft accounts can join.
- **Whitelist**: only players you add can join. Turning it on adds everyone who has played and
  your ops first.
- **BungeeCord mode** off, unless the server sits behind a proxy (otherwise anyone can pretend to be
  anyone).
- **RCON** and **query**: kept off the internet.
- **Firewall**: only the game ports are open.
- **Log4Shell**: old versions get Mojang's fix at every start.
- **Block logging**: CoreProtect (Paper) or Ledger (Fabric), so griefing can be rolled back.
- **Panel access**: whether the panel itself is reachable from other machines.

Checks count more when the server is reachable from the internet. **Harden this server** applies
every automatic fix at once, plus the plugins you choose (CoreProtect, LuckPerms).

## Windows Firewall

When Java first starts, Windows asks whether to allow it. **Allow** creates a rule that opens
every port to Java (RCON included); **Cancel** creates a rule that blocks everyone. The **Fix**
button in the Security tab (one administrator prompt) replaces both with rules for each server's
game ports only.

## The panel

- The panel has one account, the owner. Passwords are hashed with argon2id, and logins are rate
  limited.
- Cloud tokens, SSH keys and tunnel keys are encrypted with a key that only your password
  unlocks. After a restart they stay locked until you log in.
- By default the panel only answers on the machine it runs on. If you open it to your network,
  it is plain HTTP: anyone on the network can reach the login page. Before exposing it to the
  internet, use HTTPS (a reverse proxy, or Tailscale) and set `SECURE_COOKIES=true`.
- The web app only loads its own scripts and forbids being framed by other sites.

## VPS hosts

cubehold sets a VPS up with its own SSH key, a firewall that only allows SSH and game ports,
fail2ban, and automatic security updates. It can also turn off password logins for SSH. The
agent on the VPS listens on its loopback only and is reached through SSH.
