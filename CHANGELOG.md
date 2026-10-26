# Changelog

## 1.1 — 2026-10-26

- Gmail tab works: reads unread mail over IMAP with the GNOME Online Accounts token, since Google's REST API is not enabled for GNOME's OAuth client (#2).
- Runs on GNOME Shell 46 to 50, so Zorin OS 18, Ubuntu 24.04, Debian 13 and other GNOME distros work, not just Shell 50.
- Gmail and GitHub tabs no longer touch destroyed widgets when the extension is turned off mid-fetch.
- Claude sessions running in a Tilework tile show the tile's name, and clicking one zooms Tilework to that tile.

## 1.0 — 2026-10-25

First release.

- Pill in the top bar center with flared corners; collapsed, hover and open states morph width, height and radius on springs. Speed and Bounce in settings; respects "reduce animations".
- Whole top bar restyled, with a font picker for the island and the bar.
- Live activities with priorities: Claude Code permission, error, done and working; timer; volume in place of the stock OSD; headphones with battery; new Gmail and GitHub items; now playing; mic and camera dots.
- Claude Code: answer permission prompts from the pill (Allow once, Always allow, Deny, Open terminal); hook installer with backup and clean removal.
- Tabs in Dev and Life presets: Claude, Stats, Media with synced lyrics, Timer, Clipboard, Weather, Calendar, Gmail, GitHub.
- Clean disable: every actor, signal, timer, D-Bus subscription and grab released.
