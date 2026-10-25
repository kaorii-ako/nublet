#!/bin/sh
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
state="${XDG_CACHE_HOME:-$HOME/.cache}/nublet-nested"

mkdir -p "$state/config" "$state/data/gnome-shell/extensions"
ln -sfn "$root" "$state/data/gnome-shell/extensions/nublet@kaorii-ako"
glib-compile-schemas "$root/schemas"

distrobox enter nublet-dev -- env \
    DBUS_SYSTEM_BUS_ADDRESS=unix:path=/run/host/run/dbus/system_bus_socket \
    XDG_CONFIG_HOME="$state/config" \
    XDG_DATA_HOME="$state/data" \
    GSETTINGS_SCHEMA_DIR="$root/schemas" \
    NUBLET_FONT="${NUBLET_FONT:-}" \
    TZ="$(timedatectl show -p Timezone --value 2>/dev/null)" \
    dbus-run-session sh -c '
        gsettings set org.gnome.shell disable-user-extensions false
        gsettings reset org.gnome.shell disabled-extensions
        gsettings set org.gnome.shell enabled-extensions "[\"nublet@kaorii-ako\"]"
        gsettings set org.gnome.shell.extensions.nublet font-family "$NUBLET_FONT"
        exec gnome-shell --devkit --wayland
    ' || true

rm -f "${XDG_RUNTIME_DIR:?}/gnome-shell-disable-extensions"
