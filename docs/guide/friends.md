# Letting friends join

On your home network, friends join at the address the **Overview** tab shows. For friends
elsewhere, the server has to be reachable from the internet. A server's **Network** tab shows
every option, which ones are set up, and a **Test from the internet** button.

## Which option?

| Option | Works when | Players see |
| --- | --- | --- |
| **playit.gg** | Always, even behind CGNAT or a router you cannot change | An address like `name.joinmc.link` |
| **Router port forwarding (UPnP)** | Your router supports UPnP and you have a public IP address | Your public IP address |
| **Tailscale** | Friends install Tailscale (private), or through Funnel (public) | A Tailscale name |
| **ngrok** | You have an ngrok account with a card on file | An address that changes when ngrok restarts |
| **Cloudflare Tunnel** | Friends are willing to run a small command first | A hostname on your domain |
| **A VPS or cloud server** | You want the server online when your PC is off | The VPS's IP address |

If you are unsure, use **playit.gg**. It is free and works on any network. It only runs on
Windows and Linux, though: playit.gg makes no macOS agent, so on a Mac use one of the others.

## playit.gg

1. On the **Hosts** page (or a server's Network tab), press **Link playit.gg** and approve the
   link on playit.gg with your account.
2. cubehold downloads playit's official agent, checks it, and runs it in the background.
3. playit.gg does not let programs create tunnels by themselves, so add the tunnel on playit.gg.
   The Network tab shows exactly what to enter (Minecraft Java, local port). Its address then
   appears in the panel.

The agent's key is stored encrypted with your password. After the computer restarts, log in to
the panel once to start the tunnel again.

## Router port forwarding

Turn on **Forward the port on my router** in the Network tab. cubehold asks the router (UPnP) for a
one-hour forward and renews it every 20 minutes, so it closes by itself when the computer is off,
and removes it when the agent stops. The panel tells you
when forwarding cannot work: shared addresses (CGNAT) from your internet provider, two routers in
a row, or traffic going through a VPN.

If your router has no UPnP, forward the TCP port shown in the Network tab by hand in the router's
settings, to the computer's address on your network.

## ngrok, Tailscale and Cloudflare Tunnel

Each is set up from the **Network** tab: paste a token or sign in, and cubehold downloads, checks
and runs the program.

- **ngrok**: needs a free ngrok account with a card on file (ngrok requires it for TCP addresses
  and does not charge it). One ngrok connection carries every shared server. The address changes
  whenever ngrok restarts, and it is Java Edition only (no UDP).
- **Tailscale**: friends who accept your shared machine join at its Tailscale name, privately.
  **Funnel** instead makes a server public on port 443, 8443 or 10000, with nothing for players to
  install. On Windows, cubehold can install Tailscale for you (one administrator prompt).
- **Cloudflare Tunnel**: create the tunnel in the Cloudflare dashboard and paste its token.
  Cloudflare only passes raw TCP to another cloudflared, so every player runs
  `cloudflared access tcp …` first. The Network tab shows the command for each system.

## Checking that it works

Press **Test from the internet**. It asks an outside service to connect to your server and tells
you why it failed if it did (firewall, forward missing, CGNAT, VPN). It works while the server is
stopped too.

## Bedrock players

Players on phones, consoles and Windows 10/11 Bedrock can join Java servers through Geyser.
Turn on **Bedrock players** in the Network tab (Paper and Purpur 1.20.5 or newer, or Fabric). Each
server gets its own UDP port starting at 19132; forward it too. Bedrock names start with a dot
(`.Steve`).
