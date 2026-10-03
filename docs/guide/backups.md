# Backups and schedules

## Backups

A server's **Backups** tab makes a zip of the world and settings while the server keeps running:
cubehold pauses world saving for a moment so the copy is consistent, then turns it back on.

- **Restore** stops the server, first makes a safety backup of the current state, replaces what the
  backup contains, and starts the server again.
- **Download** a backup to keep a copy somewhere else.
- **Retention**: automatic backups (scheduled ones, and safety backups before a restore) are pruned
  to the number you choose in Settings. Backups you make by hand are never deleted automatically.

Backups are stored on the machine that runs the server, next to the server. Download important
ones: a disk failure takes the backups with it.

## Schedules

A server's **Schedules** tab runs tasks on a timetable:

| Task | Notes |
| --- | --- |
| Restart | Warns players in chat first (you choose how long before). |
| Stop / Start | For example, off at night. |
| Backup | Nightly backups are a good start. |
| Command | Any console command. |
| Message | A chat message to everyone online. |

Times use the time zone of the machine running the panel. **Run now** tries a schedule
immediately.

Schedules run in the panel. A schedule due while the panel is closed (or a VPS is offline) is
skipped, not run late.

## Changing the Minecraft version

**Settings → Version** moves a server to another version, up or down. cubehold snapshots the world
first, tagged with the version that saved it. Going back down can restore the world saved on that
version, keep the current world (chunks may not load), or start fresh.
