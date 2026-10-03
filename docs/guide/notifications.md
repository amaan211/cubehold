# Discord notifications

cubehold can post in a Discord channel when a server starts or stops, crashes, when players join or
leave, when a backup fails, and when a cloud VM is turned on or off.

## Set it up

1. In Discord, open the channel's settings: **Integrations → Webhooks → New Webhook**. Give it a
   name and picture if you like, then **Copy Webhook URL**.
2. In cubehold, open the server's **Settings → Discord notifications** and paste the URL.
3. Press **Send a test** and check the channel.
4. Choose what to hear about, then **Save**.

Each server has its own webhook, so different servers can post in different channels (or the same
one).

## What gets posted

| Switch | Messages |
| --- | --- |
| Starts, stops and sleep | "Survival is online" (with the address on a VPS or cloud host), "stopped" (and whether it stopped because nobody was online), "is sleeping". |
| Crashes | What went wrong in one line, the suggested fix, and whether it restarts by itself. |
| Players joining and leaving | "Steve joined Survival · 3 online". |
| Failed backups | Why the backup failed. |
| Finished backups | Off by default, since nightly backups would post every night. |
| Cloud VM turned on or off | The VM started (with its new address), was switched off, or saved as a snapshot. |

cubehold only reports what it sees happen. Restarting the panel does not repeat the state of every
server. Messages never mention `@everyone` or anyone else, whatever a player calls themselves.

If Discord refuses a message (for example because the webhook was deleted), the notifications
card says so.

## Keep the URL private

Anyone with the webhook URL can post in that channel. If it leaks, delete the webhook in Discord
and make a new one.
