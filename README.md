# Nublet

Nublet turns the clock in your GNOME top bar into a black pill that comes alive when something
happens. It shows what your Claude Code sessions are doing and lets you approve them, what is
playing, your volume, a running timer, your headphones' battery, and whether your mic or camera
is in use. Click it for tabs with system stats, media controls, weather, your calendar,
clipboard history, Gmail and GitHub.

Built for GNOME Shell 50 on Wayland. Inspired by Atoll for macOS, written from scratch.

## Install

**From extensions.gnome.org:** search for Nublet and switch it on.

**From a release zip:**

```sh
gnome-extensions install --force nublet@kaorii-ako.shell-extension.zip
```

Log out and back in, then turn it on with `gnome-extensions enable nublet@kaorii-ako`.

If another extension also uses the center of the top bar, turn that one off first.

## Use it

- Hover the pill to nudge it, click to open, press Esc or click outside to close.
- **Dev and Life:** the switch at the top left of the open island picks a set of tabs.
  Choose which tabs each set shows in settings, on the Presets page.
- **Settings:** the gear in the open island, or `gnome-extensions prefs nublet@kaorii-ako`.

### Claude Code

Open settings, find **Claude Code**, press **Install**. Nublet adds a small hook to
`~/.claude/settings.json` and saves a backup next to it first. Your other hooks stay as they
are, and **Remove** takes only Nublet's entries out again.

When Claude needs permission, the pill shows the project and tool with a shield. Click it to
**Allow once**, **Always allow**, **Deny** or **Open terminal**. If you don't answer within
two minutes, the question goes back to your terminal as usual and an amber dot stays on the
pill. When Nublet isn't running, Claude Code behaves exactly as without it.

Clicking a session's name raises its terminal window, and its tmux pane if it runs in tmux.

### Needs setup

| Tab | What it needs |
| --- | --- |
| Gmail | A Google account in Settings, Online Accounts, with Mail turned on |
| GitHub | The GitHub CLI, logged in with `gh auth login` |
| Weather | GNOME Weather with a city chosen |
| Calendar | An account with a calendar in Settings, Online Accounts |
| Media | Any player that supports MPRIS (most do). Pick a favourite in settings if you run several |
| Stats | Nothing. If you have more than one GPU, Nublet shows the one with the most video memory; pick another by PCI address in settings |

## Privacy

Everything stays on your computer. No server, no analytics. Details in [PRIVACY.md](PRIVACY.md).

## Develop

```sh
git clone https://github.com/kaorii-ako/nublet ~/projects/nublet
cd ~/projects/nublet
glib-compile-schemas schemas/
ln -sfn ~/projects/nublet ~/.local/share/gnome-shell/extensions/nublet@kaorii-ako
```

Log out and back in once so the shell discovers it.

### Nested shell

Wayland cannot restart the shell in place, so iterate in a nested shell. One-time setup of
an `nublet-dev` distrobox (Fedora 44 matches Shell 50):

```sh
distrobox create --name nublet-dev --image registry.fedoraproject.org/fedora:44
distrobox enter nublet-dev -- sudo dnf install -y gnome-shell mutter-devkit dbus-daemon
```

The dnf run may end with "Rpm transaction failed" because udev scriptlets cannot run in a
container; the packages are installed anyway.

```sh
./dev/nested.sh
NUBLET_FONT='Inter' ./dev/nested.sh
```

It opens a window running a fresh shell with only Nublet enabled. Its settings and extension
folder live in `~/.cache/nublet-nested`, so nothing it does touches your real session. Logs
print to that terminal. The script also removes the `gnome-shell-disable-extensions` crash
marker the nested shell leaves in your runtime folder.

Don't run `gsettings` on the host with a different `XDG_CONFIG_HOME` to reach the nested
shell: host `gsettings` talks to your real session's dconf service.

Real session logs: `journalctl -f -o cat /usr/bin/gnome-shell`

### Checks and release

```sh
gjs -m spring.test.js
gjs -m parsers.test.js
python3 -I dev/test_hook.py
./dev/pack.sh
```

`dev/pack.sh` runs the checks and builds `dist/nublet@kaorii-ako.shell-extension.zip`, leaving
tests and dev tools out.

### Files

| File | Role |
| --- | --- |
| `extension.js` | enable and disable; hides the stock clock and reuses its slot as the spacer |
| `island.js` | the island: states, spring morph, live activities, tabs, input |
| `spring.js`, `anim.js` | springs with Apple-style response and damping, exact ease-out curve |
| `activities.js` | picks which live activity the pill shows |
| `views.js` | tab registry |
| `claude.js`, `claudeView.js` | Claude session state, permission answers, terminal focus, the Claude tab |
| `nublet-claude-hook.js`, `hookInstall.js` | the Claude Code hook and its installer |
| `system.js` | volume, headphones battery, mic and camera dots |
| `media.js`, `lyrics.js` | MPRIS player and synced lyrics |
| `stats.js`, `statsParse.js` | the Stats tab |
| `timer.js`, `clipboard.js`, `agenda.js`, `weather.js` | the other tabs |
| `feed.js`, `gmail.js`, `github.js`, `links.js` | Gmail and GitHub |
| `prefs.js`, `schemas/` | settings |
| `dev/` | nested shell, packer, hook test |

## Features

Island
- [x] Pill flush with the top edge with flared corners; collapsed, hover and open states morph on springs
- [x] Opening bounces slightly, hover and close never overshoot; Speed and Bounce in settings
- [x] Panel neighbours slide with the island instead of jumping
- [x] Press dips to 97%; text swaps blur-crossfade; content drops in with a short stagger
- [x] Respects the system "reduce animations" setting
- [x] Whole top bar restyled; font picker for the island and the bar
- [x] Clean disable: every actor, signal, timer, D-Bus subscription and grab released

Live activities, highest priority wins
- [x] Claude permission, Claude error, timer done, volume, headphones, new Gmail or GitHub items,
      Claude done, waiting in terminal, timer running, now playing, Claude working, otherwise the clock
- [x] Orange dot while the mic is in use, green while the camera is

Tabs
- [x] Claude: every session, Allow once, Always allow, Deny, Open terminal
- [x] Stats: CPU load and temperature, GPU busy and temperature, memory, NVMe, network
- [x] Media: art, title, artist, click-to-seek progress, previous, play or pause, next; optional synced lyrics
- [x] Timer: presets, +1 minute, countdown in the pill, sound when done
- [x] Clipboard: last 20 texts in memory only, skips password managers
- [x] Weather, Calendar, Gmail, GitHub

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
