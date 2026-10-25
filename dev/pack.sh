#!/bin/sh
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
out="$root/dist"
mkdir -p "$out"

cd "$root"
gjs -m spring.test.js
gjs -m parsers.test.js
python3 -I dev/test_hook.py

sources=""
for f in *.js; do
    case "$f" in
        extension.js|prefs.js|*.test.js) ;;
        *) sources="$sources --extra-source=$f" ;;
    esac
done

gnome-extensions pack --force --out-dir="$out" \
    --schema=schemas/org.gnome.shell.extensions.nublet.gschema.xml \
    --extra-source=LICENSE \
    --extra-source=PRIVACY.md \
    $sources

unzip -l "$out/nublet@kaorii-ako.shell-extension.zip"
