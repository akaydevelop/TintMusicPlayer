# Tint

A small music player for Windows and Linux. It plays the music files on this PC and, once set up, your
Apple Music library, the Apple Music catalog and YouTube Music's catalog. The whole window, title bar included, takes its
colors from the cover of the song that is playing.

## Run it

    .\tools\publish.ps1            # builds dist\Tint.exe
    .\tools\publish.ps1 -Shortcut  # same, and adds a Start menu shortcut
    .\dist\Tint.exe

A release download (`Tint-<version>-win-x64.zip`) holds the same `dist` folder.
Needs Windows 11, the .NET 10 Desktop Runtime and the Edge WebView2 Runtime (part of Windows 11).

### On Linux

    tools/linux/install.sh                   # builds and installs for this user (needs the .NET 10 SDK)
    tools/linux/install.sh --self-contained  # the same, bundling .NET so the runtime isn't needed
    tools/linux/install.sh --uninstall

A release download (`Tint-<version>-linux-x64.tar.gz`, or `-linux-arm64`) is already built and
bundles .NET: unpack it and run its `install.sh`.

To remove Tint later, run `~/.local/opt/tint/uninstall.sh`, which `install.sh` leaves next to the
program. It keeps the settings and library in `~/.local/share/Tint`; `--all` deletes those too,
with the sign-ins.

Then start Tint from the app menu, or run `tint`. The window is an app window of Google Chrome,
Microsoft Edge or Brave (whichever is installed; `TINT_BROWSER` picks one), with a profile of its
own, so it never touches the browser you use. That browser is what plays Apple Music's full songs:
they are protected with Widevine, which Chromium as most distributions package it lacks, so with
Chromium alone Apple Music plays only previews. The media keys and the desktop's player controls
(MPRIS: GNOME's and KDE's media widgets, `playerctl`) come from the browser too. File dialogs use
zenity or kdialog when either is installed. Discord's desktop app, including the Flatpak and Snap
packages, is found the same way as on Windows.

On Linux the Apple Music key and token Tint keeps are not encrypted (there is nothing built in to
match Windows' per-user encryption); `~/.local/share/Tint` is made readable by its owner alone.

### Updates

A copy installed from a release keeps itself current (`Updater.cs`). Every few hours Tint asks
GitHub for this repository's releases; when a newer one is out, a notice offers it, and Settings
shows the same under Updates. Choosing Update downloads that release's package for this system
and checks it against the SHA-256 GitHub lists for it (a download that doesn't match is thrown
away). Restart now then puts it in place: the program's files are renamed aside, the new ones
moved in, and the new Tint starts and clears the old files away. Settings, library and sign-ins
are in the data folder and stay as they are. A build run from the project folder, or with
`--dev`, doesn't look for updates; neither does a copy in a folder it can't write to.

## Music on this PC

Tint scans `Music\iTunes\iTunes Media` and `Music\Apple Music\Media` by default (on Linux, the
whole `~/Music` folder); add or remove folders in Settings. It plays MP3, AAC/M4A, FLAC, WAV, Ogg and Opus, and picks up new files on
its own.

An album's cover is the picture in its files, or else an image beside them (`cover.jpg`,
`folder.jpg` and the like). An album with neither gets its cover from Apple, looked up by album
and artist the first time it is shown and kept with the other thumbnails (`CoverLookup.cs`):
first Apple's public iTunes Search service, then, when Apple Music is set up, the Apple Music
catalog, which has the albums iTunes Search leaves out (new ones especially). Only a result by the
same artist with the same album name counts.

Two kinds of file are left out or greyed:

- `.m4p` files are Apple Music subscription downloads. They are locked to Apple's own apps, so
  Tint plays those songs by streaming them from Apple Music instead.
- Apple Lossless (ALAC) files are listed but can't be played yet.

## Apple Music

Apple only lets an app stream subscription music if the app presents a developer token. Settings
offers two ways to get one. Either way Tint loads Apple's MusicKit player, you sign in with your
normal Apple Account, and streaming and DRM are handled by Apple's own code.

- **The web player's token.** Tint reads the token that music.apple.com gives every visitor
  (`WebPlayerToken` in `AppleToken.cs`) and refreshes it when Apple rotates it. Apple only honors
  that token for pages on apple.com, so the app's page is shown under
  `https://music.apple.com/tint/` inside the WebView, with every request below that address
  answered locally (`PageBridge.cs`). No paid account is needed. Apple's terms don't provide for
  this, and it can break whenever Apple changes their site.
- **Your own MusicKit key.** Members of the Apple Developer Program enter their Team ID and Key ID
  and choose the `.p8` file. Tint signs tokens itself; the key is stored encrypted for your
  Windows account. This is the route Apple intends.

## YouTube Music

Switched on in Settings, search also covers YouTube Music's catalog, and its albums, artists and
songs open and play like the rest. Catalog questions go to the service behind music.youtube.com (`YouTube.cs`). The audio
comes one of two ways, chosen in Settings:

- **YouTube Music's own player** (the default once signed in to Google). The host keeps
  music.youtube.com open in a second browser view that is never shown (`YouTubePage.cs`), and a
  script put into that page (`wwwroot\js\youtube-page.js`) works the site's player for Tint. A
  song starts in about a second. It plays at the audio quality set in the YouTube Music account,
  which Tint sets to High (about 256 kbps AAC with Premium).
  This route does not require yt-dlp or its token helper. Tint's player monitoring stops while
  paused or idle; the site stays loaded so the next song does not need a fresh page load.
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)**, which finds where YouTube keeps a song's audio
  so Tint's own player can play it. This takes several seconds a song (the next two are looked up
  ahead of time), and is what plays a song the site's player couldn't start, or any song when
  signed out. yt-dlp is not part of Tint: it is used from PATH, or Settings can download the
  current release into Tint's data folder (checked against the release's published SHA-256). It
  in turn needs Deno or Node.js to read YouTube's player.

The line under the progress bar shows what is actually playing.

A YouTube or YouTube Music link pasted into the search box opens that very video, at the top of
the results, followed by what a search for its title finds. Search doesn't list every video
YouTube Music can play, so this reaches the ones it misses.

Signed in to Google (below), the albums, songs and playlists of your own YouTube Music library
join the Albums, Songs and Playlists pages as a source next to this PC and Apple Music.

Signed out, YouTube sends about 128 kbps, and refuses some songs outright when it suspects a
program is asking. A Premium account's better audio (about 256 kbps) takes two more things, both
set up in Settings:

- **A Google sign-in.** Tint opens Google's sign-in in a window of its own, then keeps YouTube's
  cookies from it in `%LOCALAPPDATA%\Tint\youtube\cookies.txt` for yt-dlp to use (`--cookies`).
  That file is a working sign-in to YouTube, stored as plain text; signing out deletes it. yt-dlp's
  makers warn that YouTube can restrict an account used this way.
- **A token helper.** The YouTube Music player has to show a "proof of origin" token.
  [bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider), which
  yt-dlp's guide recommends, makes them: a plug-in for yt-dlp and a small server run by Deno
  (`YouTubeTokens.cs`). It is about 190 MB on disk and about 170 MB of memory while it runs. Tint
  starts it when a YouTube song is fetched and stops it ten minutes after the last one. Like the web player's token above, none of this is provided
for by the service's terms, and it breaks when YouTube changes things until yt-dlp catches up.

## When a service won't play a song

If Apple Music or YouTube Music refuses a song (Apple's block on explicit songs, a song missing
in your region, YouTube turning a request away), Tint looks for the same recording on the other
one and plays it from there. The song keeps its place, title and cover; the icon beside the
artist shows where it is really coming from. `match.js` decides what counts as the same
recording: the title, the artist and the length all have to be convincing. If nothing convincing
turns up, the song fails as before.

## Fades

Playing and pausing fade the sound in and out (150 ms to start with), and moving to another song
while one plays crossfades into it (800 ms). Settings, under Playback, sets both, or turns them
off at 0. Files and songs fetched with yt-dlp cross over each other on two `<audio>` elements, as
does any skip from one service to another. MusicKit and the YouTube Music page each sound one
song at a time, so between two of their own songs the last fades out and then the next fades in.

## Artists

An artist has one page, whether it is opened from Apple Music, YouTube Music, an album on this PC,
the artist's name under the song playing, or "Go to artist" on a song. `artist.js` puts it
together from both services: Apple Music gives the photo, the genre, the top songs, similar
artists and the discography, with albums, EPs, singles, live albums and compilations apart (when
Apple Music isn't set up, YouTube Music's shelves stand in); YouTube Music gives the "About" text
and how many people listen. The artist is found on the other service by the same name or, for a
name written another way there, by who sings the same top songs. Albums by the artist on this PC
come first.

## Lyrics

The speech-bubble button beside the song playing opens its lyrics. The line being sung lights up
and stays in view; clicking a line plays from there, and scrolling by hand pauses the following
for a few seconds. For a song from Apple Music, Apple's own timed lyrics are asked for first
(through MusicKit, so they need the Apple sign-in). Then the host (`Lyrics.cs`) asks YouTube
Music, for the song's own video or the same recording found by name: its Android app's service
sends timed lyrics where the web page only gets plain text. Last is
[LRCLIB](https://lrclib.net), a free public collection of timed lyrics looked up by title, artist
and length. Plain lyrics are shown only when nobody has timed ones.

Japanese lyrics can be switched to romaji (`romaji.js`). Kanji need a dictionary to know how they
are read, so [kuromoji](https://github.com/takuyaa/kuromoji.js) (Apache-2.0, in
`wwwroot\vendor\kuromoji`) splits each line into words and gives their readings, which are then
spelled in Hepburn. Its 17 MB dictionary isn't in the download: the first time romaji is asked
for, the host fetches it (`JapaneseDictionary.cs`), checks each file's SHA-256 and keeps it in the
data folder.

## Discord

Tint can show the current song on your Discord profile ("Listening to ..."), with the artist,
cover and a progress bar. It clears when you pause or close Tint.

Discord shows a status under the name of an application, so you need one of your own (free):
create an application in the Discord Developer Portal, copy its Application ID, and paste it in
Settings. Tint then talks to the Discord desktop app on this PC; nothing is sent anywhere else.

Covers of Apple Music songs are public links Discord can load. For files on this PC, Tint looks
the album up by name in Apple's public iTunes Search service and uses that cover. If no confident
match is found the status goes out without one.

## How it is put together

- `src\` holds what both builds share: a loopback HTTP server (`LocalServer.cs`) that serves the
  UI, the audio files and a small JSON API, the folder scanner (`Library.cs`), the token signer
  (`AppleToken.cs`), YouTube through yt-dlp (`YouTube.cs`, `YouTubeTokens.cs`) and the Discord
  status (`DiscordPresence.cs`, with `CoverLookup.cs` finding public covers for local albums).
  `Host.cs` is what the server needs from the window, whichever build it is.
- `src\Windows\` is the Windows host: one WinForms window holding a WebView2 (`MainForm.cs`,
  `PageBridge.cs`, `YouTubePage.cs`) and the Windows media controls (`SystemMedia.cs` for the media
  keys and the system media panel, `TaskbarButtons.cs` for the buttons under the taskbar preview).
- `src\Chrome\` is the Linux host: an installed Chrome-family browser, started with its own
  profile and driven over the DevTools protocol on a private pipe (`Browser.cs`, `Cdp.cs`). It
  answers the page's requests the way `PageBridge.cs` does (`ChromeHost.cs`), and
  `wwwroot\js\host-bridge.js` gives the page WebView2's messaging, so the UI is the same code.
  `Tint.csproj` builds `net10.0-windows` for the first and `net10.0` for this one.
- `wwwroot\` is the UI in plain HTML, CSS and JavaScript modules. No framework, no build step.
  `player.js` owns the queue and drives two engines (an `<audio>` element for files and for
  YouTube songs, MusicKit for Apple Music); `palette.js` reads cover colors; `views.js` holds the
  pages; `youtube.js` reads YouTube Music's answers.
- App data lives in `%LOCALAPPDATA%\Tint` on Windows and `~/.local/share/Tint` on Linux (settings,
  library cache, cover thumbnails, browser profile). `TINT_DATA` points it elsewhere, for trying a
  build out without touching the settings of the copy in daily use.

## Working on it

    .\tools\dev.ps1                          # build and run with --dev
    node tools\eval.mjs "tint.player.state"  # run JavaScript inside the running dev window
    .\tools\shot.ps1                         # save a screenshot of the window

In dev mode the UI is served straight from `wwwroot`, so edit and press F5. F12 opens DevTools.
The Linux build runs on Windows too, for trying it out: `dotnet run -f net10.0 -- --dev` (with
`TINT_DATA` set to a scratch folder), and `tools\eval.mjs` reaches its page the same way.
`tools\check-token.mjs` verifies token signing with a throwaway key. `tools\probe-webtoken.mjs`
reports where Apple's site currently keeps its web player token and what the API requires, which
is the first thing to run if that route stops working.

## Keys

Space plays and pauses. Ctrl+Right and Ctrl+Left change songs. Ctrl+F or `/` searches.
Alt+Left goes back.

The keyboard's media keys (play/pause, next, previous) work whichever app is in front, and the
same three buttons sit under Tint's preview on the taskbar. Windows' media panel in Quick Settings
shows the song and its cover. Turning the mouse wheel over the volume row changes the volume.
