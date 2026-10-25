# Nublet

<p align="center"><strong>A live top bar for GNOME</strong> — <em>your clock, awake.</em></p>

<p align="center"><sub>Claude Code approvals from the bar · now playing · volume · timers · stats · <em>zero polling while idle</em></sub></p>

<p align="center">
<a href="https://github.com/kaorii-ako/nublet/releases/latest"><img src="https://img.shields.io/github/v/release/kaorii-ako/nublet?style=flat-square" alt="release"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--2.0--or--later-blue?style=flat-square" alt="license"></a>
<a href="https://kaorii-ako.github.io/nublet/"><img src="https://img.shields.io/badge/GNOME%20Shell-50-4A86CF?style=flat-square&logo=gnome&logoColor=white" alt="GNOME Shell 50"></a>
<a href="https://kaorii-ako.github.io/nublet/"><img src="https://img.shields.io/badge/site-kaorii--ako.github.io%2Fnublet-181717?style=flat-square" alt="site"></a>
</p>

<p align="center">
<code>gnome-extensions install --force nublet@kaorii-ako.shell-extension.zip</code>
</p>

<p align="center">
<a href="https://claude.com/product/claude-code" title="Claude Code"><img src="https://cdn.simpleicons.org/claude/D97757" height="26" alt="Claude Code"></a>&nbsp;
<a href="https://www.gnome.org" title="GNOME"><picture><source media="(prefers-color-scheme: dark)" srcset="https://cdn.simpleicons.org/gnome/FFFFFF"><img src="https://cdn.simpleicons.org/gnome/000000" height="26" alt="GNOME"></picture></a>&nbsp;
<a href="https://cli.github.com" title="GitHub"><picture><source media="(prefers-color-scheme: dark)" srcset="https://cdn.simpleicons.org/github/FFFFFF"><img src="https://cdn.simpleicons.org/github/181717" height="26" alt="GitHub"></picture></a>&nbsp;
<a href="https://mail.google.com" title="Gmail"><img src="https://cdn.simpleicons.org/gmail/EA4335" height="26" alt="Gmail"></a>&nbsp;
<a href="https://www.freedesktop.org/wiki/Specifications/mpris-spec/" title="Any MPRIS player"><img src="https://cdn.simpleicons.org/musicbrainz/BA478F" height="26" alt="MPRIS"></a>
</p>

<p align="center"><img src="docs/assets/pill_permission.webp" width="420" alt="The Nublet pill asking to approve a Claude Code command"></p>

---

> **At a glance:** the pill is quiet until something happens. Idle CPU stays near zero: nothing polls while it is collapsed, and stats are read only while their tab is open.

---

Nublet turns the clock in your GNOME top bar into a black pill that comes alive when something happens. It shows what your Claude Code sessions are doing and lets you approve them, what is playing, your volume, a running timer, your headphones' battery, and whether your mic or camera is in use. Click it for tabs with system stats, media controls, weather, your calendar, clipboard history, Gmail and GitHub.

Built for GNOME Shell 50 on Wayland. Inspired by Atoll for macOS, written from scratch.

## Why

The GNOME top bar shows a clock and not much else. Things you care about happen elsewhere: a Claude session stalls on a permission prompt in a terminal you can't see, a song changes, a timer runs out. Nublet puts those moments in the one spot your eyes already go to, and lets you act on them without switching windows.

## How it works

```
 Claude Code ──hook──▶ $XDG_RUNTIME_DIR/nublet-claude/*.json ─┐
 MPRIS players ─────── D-Bus ─────────────────────────────────┤
 PipeWire / UPower ─── D-Bus ─────────────────────────────────┤   file monitors and
 Shell OSD, camera ─── in-process ────────────────────────────┤   signals, no polling
                                                              ▼
                                                    ┌───────────────────┐
                                                    │ live activities   │  highest
                                                    │ (priority + TTL)  │  priority wins
                                                    └─────────┬─────────┘
                                                              ▼
                                  ┌──────────── the pill ────────────┐
                                  │ collapsed ⇄ hover ⇄ open (tabs)  │
                                  │ width, height, radius on springs │
                                  └──────────────────────────────────┘
```

### Live activities

What the pill shows, highest priority first:

- **Claude** permission → error
- **Timer** done
- **Volume** change (replaces the stock OSD)
- **Headphones** connected, with battery
- **New** Gmail or GitHub items
- **Claude** done → waiting in terminal
- **Timer** running
- **Now playing**, with art and audio bars
- **Claude** working
- otherwise the **clock**

An orange dot shows while the mic is in use, a green one while the camera is.

## Which tabs do I need?

The switch at the top left of the open island picks **Dev** or **Life**. Choose which tabs each preset shows on the Presets page in settings.

| Tab | Needs |
|---|---|
| **Claude** | Press **Install** under Claude Code in settings |
| **Stats** | Nothing. With several GPUs, the one with the most video memory is used; pick another by PCI address in settings |
| **Media** | Any MPRIS player (most are). Pick a favourite in settings if you run several |
| **Timer**, **Clipboard** | Nothing |
| **Weather** | GNOME Weather with a city chosen |
| **Calendar** | An account with a calendar in Settings → Online Accounts |
| **Gmail** | A Google account in Settings → Online Accounts with Mail on |
| **GitHub** | The GitHub CLI, logged in with `gh auth login` |

## Install

**From extensions.gnome.org:** search for Nublet and switch it on.

**From a release:** download [`nublet@kaorii-ako.shell-extension.zip`](https://github.com/kaorii-ako/nublet/releases/latest/download/nublet@kaorii-ako.shell-extension.zip), then:

```bash
gnome-extensions install --force nublet@kaorii-ako.shell-extension.zip
```

Log out and back in, then:

```bash
gnome-extensions enable nublet@kaorii-ako
```

If another extension also uses the center of the top bar, turn that one off first.

## Use it

- Hover the pill to nudge it, click to open, press Esc or click outside to close.
- **Settings:** the gear in the open island, or `gnome-extensions prefs nublet@kaorii-ako`.

### Claude Code

Open settings, find **Claude Code**, press **Install**. Nublet adds a small hook to `~/.claude/settings.json` and saves a backup next to it first. Your other hooks stay as they are, and **Remove** takes only Nublet's entries out again.

When Claude needs permission, the pill shows the project and tool with a shield. Click it to answer:

| Button | Does |
|---|---|
| **Allow once** | Runs this one command |
| **Always allow** | Saves the rule Claude suggests |
| **Deny** | Claude is told and carries on |
| **Open terminal** | Jumps to the session instead |

No answer within two minutes and the question goes back to your terminal as usual, with an amber dot left on the pill. When Nublet isn't running, Claude Code behaves exactly as without it.

Clicking a session's name raises its terminal window, and its tmux pane if it runs in tmux.

## Privacy

Everything stays on your computer. No account, no server, no analytics. Details in [PRIVACY.md](PRIVACY.md).

## FAQ

**The pill doesn't appear after installing.**
GNOME only discovers new extensions at login on Wayland. Log out and back in, then enable it.

**The shell crashed and now all my extensions are off.**
GNOME disables extensions after a crash. Re-enable them in Extensions, and please [open an issue](https://github.com/kaorii-ako/nublet/issues) with `journalctl -o cat /usr/bin/gnome-shell` output.

**Does it work with blur-my-shell?**
Yes, with panel blur on or off.

**Does it support GNOME 49 or older?**
No. It targets Shell 50 only.

## Develop

```bash
git clone https://github.com/kaorii-ako/nublet ~/projects/nublet
cd ~/projects/nublet
glib-compile-schemas schemas/
ln -sfn ~/projects/nublet ~/.local/share/gnome-shell/extensions/nublet@kaorii-ako
```

Log out and back in once so the shell discovers it.

### Nested shell

Wayland cannot restart the shell in place, so iterate in a nested shell. One-time setup of a `nublet-dev` distrobox (Fedora 44 matches Shell 50):

```bash
distrobox create --name nublet-dev --image registry.fedoraproject.org/fedora:44
distrobox enter nublet-dev -- sudo dnf install -y gnome-shell mutter-devkit dbus-daemon
```

The dnf run may end with "Rpm transaction failed" because udev scriptlets cannot run in a container; the packages are installed anyway.

```bash
./dev/nested.sh
NUBLET_FONT='Inter' ./dev/nested.sh
```

It opens a window running a fresh shell with only Nublet enabled. Its settings and extension folder live in `~/.cache/nublet-nested`, so nothing it does touches your real session. Logs print to that terminal. The script also removes the `gnome-shell-disable-extensions` crash marker the nested shell leaves in your runtime folder.

Don't run `gsettings` on the host with a different `XDG_CONFIG_HOME` to reach the nested shell: host `gsettings` talks to your real session's dconf service.

Real session logs: `journalctl -f -o cat /usr/bin/gnome-shell`

### Checks and release

```bash
gjs -m spring.test.js
gjs -m parsers.test.js
python3 -I dev/test_hook.py
./dev/pack.sh
```

`dev/pack.sh` runs the checks and builds `dist/nublet@kaorii-ako.shell-extension.zip`, leaving tests and dev tools out.

### Files

| File | Role |
|---|---|
| `extension.js` | enable and disable; hides the stock clock and reuses its slot as the spacer |
| `island.js` | the island: states, spring morph, live activities, tabs, input |
| `spring.js`, `anim.js` | springs with response and damping, exact ease-out curve |
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
| `docs/` | the website |

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
