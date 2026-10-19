#!/bin/sh
# Builds Tint for Linux and installs it for the current user: the program in ~/.local/opt/tint,
# a `tint` command in ~/.local/bin, and an entry in the desktop's app menu.
#
# In a release download the program is already built and sits next to this script; it is copied
# as it is, and neither the .NET SDK nor --self-contained comes into it.
#
#   tools/linux/install.sh                   build and install (needs the .NET 10 SDK)
#   tools/linux/install.sh --self-contained  the same, but bundles .NET, so the computer it runs on
#                                            needs no .NET runtime (about 70 MB instead of 2)
#   tools/linux/install.sh --uninstall       removes the program, the command and the menu entry
#                                            (settings and library in ~/.local/share/Tint are kept);
#                                            the same as ~/.local/opt/tint/uninstall.sh, see there
#
# Tint shows its window in Google Chrome, Microsoft Edge or Brave, whichever is installed. One of
# them is needed for Apple Music's full songs (Chromium, as most distributions ship it, plays only
# previews). Optional: zenity or kdialog for file dialogs, yt-dlp and Deno for YouTube Music.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app="$HOME/.local/opt/tint"
bin="$HOME/.local/bin"
menu="$HOME/.local/share/applications"
icons="$HOME/.local/share/icons/hicolor/256x256/apps"

if [ "${1:-}" = "--uninstall" ]; then
    shift
    exec sh "$here/uninstall.sh" "$@"
fi

if [ -x "$here/Tint" ]; then
    echo "Installing Tint..."
    rm -rf "$app"
    mkdir -p "$app"
    cp -R "$here/Tint" "$here/wwwroot" "$app/"
    icon="$here/tint.png"
else
    root=$(CDPATH= cd -- "$here/../.." && pwd)
    command -v dotnet >/dev/null 2>&1 || { echo "The .NET 10 SDK is needed to build Tint: https://learn.microsoft.com/dotnet/core/install/linux" >&2; exit 1; }

    case "$(uname -m)" in
        x86_64) rid=linux-x64 ;;
        aarch64 | arm64) rid=linux-arm64 ;;
        *) echo "Tint isn't built for $(uname -m)." >&2; exit 1 ;;
    esac

    contained=false
    [ "${1:-}" = "--self-contained" ] && contained=true

    echo "Building Tint ($rid)..."
    rm -rf "$app"
    dotnet publish "$root/Tint.csproj" -f net10.0 -c Release -r "$rid" --self-contained "$contained" \
        -p:PublishSingleFile=true -p:DebugType=none -o "$app" -nologo -v q
    icon="$root/assets/tint.png"
fi

# Kept with the program, so it can be removed once the download is gone.
cp "$here/uninstall.sh" "$app/uninstall.sh"
chmod +x "$app/uninstall.sh"

mkdir -p "$bin" "$menu" "$icons"
ln -sf "$app/Tint" "$bin/tint"
cp "$icon" "$icons/tint.png"
cat > "$menu/tint.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Tint
GenericName=Music Player
Comment=Plays your music files, Apple Music and YouTube Music
Exec=$app/Tint
Icon=tint
Terminal=false
Categories=AudioVideo;Audio;Player;
StartupNotify=true
EOF
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$menu" || true

echo "Installed. Start Tint from the app menu, or run: tint"
echo "To remove it later: $app/uninstall.sh (add --all to delete its settings and sign-ins too)"

browser=""
for name in google-chrome-stable google-chrome microsoft-edge-stable microsoft-edge brave-browser brave vivaldi-stable vivaldi chromium chromium-browser; do
    if command -v "$name" >/dev/null 2>&1; then browser=$name; break; fi
done
case "$browser" in
    "") echo "Note: no Chrome-family browser was found. Install Google Chrome (or Edge or Brave): Tint shows its window in it." ;;
    chromium*) echo "Note: only Chromium was found. It usually lacks Widevine, so Apple Music would play previews only. Google Chrome has it." ;;
esac
if ! command -v zenity >/dev/null 2>&1 && ! command -v kdialog >/dev/null 2>&1; then
    echo "Note: without zenity or kdialog, Tint asks for folder paths in words instead of showing a file dialog."
fi
case ":$PATH:" in
    *":$bin:"*) ;;
    *) echo "Note: $bin isn't on PATH, so the 'tint' command needs its full path there." ;;
esac
