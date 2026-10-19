#!/bin/sh
# Removes Tint as install.sh put it in place: the program in ~/.local/opt/tint, the `tint` command
# and the entry in the desktop's app menu. install.sh copies this script next to the program, so
# it is there to run even once the download is gone:
#
#   ~/.local/opt/tint/uninstall.sh           removes the program; settings and library stay
#   ~/.local/opt/tint/uninstall.sh --all     also deletes Tint's data: settings, library, cover
#                                            thumbnails, its browser profile (Apple Music and
#                                            Google sign-ins) and YouTube's cookie file
set -eu

app="$HOME/.local/opt/tint"
bin="$HOME/.local/bin"
menu="$HOME/.local/share/applications"
icons="$HOME/.local/share/icons/hicolor/256x256/apps"
data="${TINT_DATA:-${XDG_DATA_HOME:-$HOME/.local/share}/Tint}"

all=false
case "${1:-}" in
    "") ;;
    --all) all=true ;;
    *) echo "usage: $0 [--all]" >&2; exit 2 ;;
esac

# Files of a running program can go, but its data folder is in use (the browser writes its profile there).
if command -v pgrep >/dev/null 2>&1 && pgrep -f "$app/Tint" >/dev/null 2>&1; then
    echo "Tint is running. Close it first, then run this again." >&2
    exit 1
fi

rm -rf "$app"
# Only the command install.sh made: a link to the program.
if [ -L "$bin/tint" ]; then rm -f "$bin/tint"; fi
rm -f "$menu/tint.desktop" "$icons/tint.png"
# The hidden entries Tint writes so its windows find their icon (see DesktopEntry.cs).
for browser in chrome msedge brave; do
    rm -f "$menu/$browser-127.0.0.1__start.html-Default.desktop" "$menu/$browser-accounts.google.com__ServiceLogin-Default.desktop"
done
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$menu" || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q "$HOME/.local/share/icons/hicolor" 2>/dev/null || true

if $all; then
    rm -rf "$data"
    echo "Tint removed, with its settings, library and sign-ins."
else
    echo "Tint removed. Its settings and library are still in $data"
    echo "(run with --all to delete them too)."
fi
