# Tint

A small music player for Windows. It plays the music files on this PC and, once set up, your
Apple Music library, the Apple Music catalog and YouTube Music's catalog. The whole window, title bar included, takes its
colors from the cover of the song that is playing.

## Run it

    .\tools\publish.ps1            # builds dist\Tint.exe
    .\tools\publish.ps1 -Shortcut  # same, and adds a Start menu shortcut
    .\dist\Tint.exe

Needs Windows 11, the .NET 10 Desktop Runtime and the Edge WebView2 Runtime (part of Windows 11).

## Music on this PC

Tint scans `Music\iTunes\iTunes Media` and `Music\Apple Music\Media` by default; add or remove
folders in Settings. It plays MP3, AAC/M4A, FLAC, WAV, Ogg and Opus, and picks up new files on
its own.

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

- `src\` is the Windows host: one WinForms window holding a WebView2, a loopback HTTP server
  (`LocalServer.cs`) that serves the UI, the audio files and a small JSON API, the folder scanner
  (`Library.cs`), the token signer (`AppleToken.cs`), the Discord status (`DiscordPresence.cs`,
  with `CoverLookup.cs` finding public covers for local albums), and the Windows media controls
  (`SystemMedia.cs` for the media keys and the system media panel, `TaskbarButtons.cs` for the
  buttons under the taskbar preview).
- `wwwroot\` is the UI in plain HTML, CSS and JavaScript modules. No framework, no build step.
  `player.js` owns the queue and drives two engines (an `<audio>` element for files and for
  YouTube songs, MusicKit for Apple Music); `palette.js` reads cover colors; `views.js` holds the
  pages; `youtube.js` reads YouTube Music's answers.
- App data lives in `%LOCALAPPDATA%\Tint` (settings, library cache, cover thumbnails, browser profile).

## Working on it

    .\tools\dev.ps1                          # build and run with --dev
    node tools\eval.mjs "tint.player.state"  # run JavaScript inside the running dev window
    .\tools\shot.ps1                         # save a screenshot of the window

In dev mode the UI is served straight from `wwwroot`, so edit and press F5. F12 opens DevTools.
`tools\check-token.mjs` verifies token signing with a throwaway key. `tools\probe-webtoken.mjs`
reports where Apple's site currently keeps its web player token and what the API requires, which
is the first thing to run if that route stops working.

## Keys

Space plays and pauses. Ctrl+Right and Ctrl+Left change songs. Ctrl+F or `/` searches.
Alt+Left goes back.

The keyboard's media keys (play/pause, next, previous) work whichever app is in front, and the
same three buttons sit under Tint's preview on the taskbar. Windows' media panel in Quick Settings
shows the song and its cover. Turning the mouse wheel over the volume row changes the volume.
