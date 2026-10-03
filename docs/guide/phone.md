# On your phone

The panel works in a phone's browser: the sections move to a bar at the bottom of the screen, and
everything fits the screen. You can add it to your home screen so it opens like an app.

## Reaching the panel from a phone

By default the panel only answers on the computer it runs on, which keeps it private.
**Settings → Phone and other devices** shows how your panel is set up and the address to use.

**Same Wi-Fi**: let the panel answer on your network.

- Windows app: add `HOST=0.0.0.0` to `%LOCALAPPDATA%\cubehold\launcher.env` and choose
  **Restart panel** in the tray menu. Windows may ask whether Node.js may use the network: allow it
  for private networks.
- Docker: this is already the case.
- Linux service: set `Environment=HOST=0.0.0.0` in `cubehold.service`.

Then open `http://<computer's address>:4000` on the phone. This is plain HTTP, so only do it on a
network you trust.

**Anywhere, with HTTPS**: use Tailscale.

1. Install Tailscale on the computer and on the phone, signed in to the same account.
2. On the computer: `tailscale serve 4000`.
3. On the phone, open the `https://…ts.net` address it prints.

The panel stays off the internet, and HTTPS makes the home-screen app work fully.

## Add to the home screen

- **Android (Chrome)**: menu → **Add to Home screen** or **Install app**.
- **iPhone (Safari)**: Share → **Add to Home Screen**.

Over HTTPS the app also shows a friendly page when the panel cannot be reached, instead of a
browser error.
