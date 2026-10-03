# Running on a VPS

A VPS is a small Linux server you rent by the month. Your Minecraft server stays online when your
computer is off, and players connect straight to its address without tunnels.

**Hosts → Getting a VPS** suggests a size for your player count and compares providers.

## Add a VPS

1. Create a VPS with **Ubuntu 22.04 or newer** or **Debian 12 or newer** (x86_64 or ARM64).
2. In cubehold: **Hosts → Add a VPS**. Enter its IP address and the root password (or an SSH key
   and a user with sudo).
3. Check the fingerprint cubehold shows against the one your provider shows, if it shows one.
4. cubehold sets the machine up in a few minutes:
   - its own SSH key, so your password is not kept,
   - Node.js and the cubehold agent, running as its own `cubehold` account,
   - a firewall (ufw) that allows SSH and your game ports only,
   - fail2ban and automatic security updates,
   - optionally, SSH logins with keys only.

Then choose the VPS as the **Host** when creating a server, or **move** an existing server to it
from the server's Settings tab. Moving copies the world, history and backups.

## Good to know

- The agent listens on the VPS's loopback only. cubehold reaches it through SSH.
- After the panel restarts, VPS hosts stay locked until you log in (the panel's key for them is
  encrypted with your password). Servers keep running on the VPS meanwhile.
- cubehold opens and closes game ports in ufw as servers come and go. It opens nothing else.
- Some providers (AWS, Oracle, Google) also have their own firewall in their console. Open the
  game port there as well.
- If you reinstall the VPS, its identity changes. The host card offers **Accept the new
  identity**, which asks for the login again.
- **Remove** can uninstall everything cubehold put on the VPS, including its key.
