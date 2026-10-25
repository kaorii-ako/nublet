# Privacy

Nublet runs entirely on your computer. It has no server, no analytics and no telemetry.

## What it reads, and where that data goes

| Feature | What Nublet reads | Where it goes |
| --- | --- | --- |
| Claude sessions | Session status, project folder name, the tool and command waiting for approval, the first line of Claude's last reply | A private folder in your runtime directory (`$XDG_RUNTIME_DIR/nublet-claude`, readable only by you, wiped at logout). Nothing leaves your computer. |
| Clipboard history | The last 20 texts you copy | Memory only. Never written to disk, gone at logout or when you press Clear. Copies flagged by password managers are skipped. |
| Gmail | Subject and sender of up to 8 unread inbox messages | Fetched directly from Google with the access token GNOME Online Accounts already holds. The token stays in memory for the request and is never stored or logged by Nublet. |
| GitHub | Your notifications | Fetched by the `gh` command you already logged in with. Nublet never sees your token. |
| Media | Title, artist, album art and position from your music player | Memory only. Album art from a web address is downloaded directly from that address. |
| Weather, calendar | Read from GNOME's own weather and calendar services | Memory only. |
| Stats | CPU, GPU, memory, disk temperature and network counters from `/proc` and `/sys` | Memory only, read once a second while the Stats tab is open. |
| Mic and camera dots | Whether any app is recording or using a camera | Memory only. Nublet never accesses the microphone or camera itself. |

## What it changes

- When you press **Install** under Claude Code in settings, Nublet adds its hook to `~/.claude/settings.json` after saving a backup next to it. **Remove** takes only Nublet's entries out again.
- When a permission request is open and you press Allow, Always allow or Deny, Nublet writes your answer to the private runtime folder, where Claude Code's hook picks it up. Always allow adds the rule Claude Code itself suggested.
- Nothing else outside GNOME's own settings for Nublet.
