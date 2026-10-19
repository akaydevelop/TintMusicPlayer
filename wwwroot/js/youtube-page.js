// This file does not run in Tint's own page. The host puts it into the hidden music.youtube.com
// page (see YouTubePage.cs), where it works the site's player for Tint: it does what Tint asks
// (load a song, play, pause, seek, volume) and reports what the player is doing.
//
// Songs are started the way a click on the site starts them, through the site's own app, because
// that is the path on which it honours the account's audio quality. Left to itself the site would
// then carry on into songs of its own choosing; this stops it there, since the queue is Tint's.

(() => {
  if (window.top !== window || location.host !== 'music.youtube.com' || window.__tint) return;
  window.__tint = true;

  const say = (message) => window.chrome.webview.postMessage(message);
  const player = () => document.getElementById('movie_player');
  const app = () => document.querySelector('ytmusic-app');

  // In a browser app window (the Linux build), the browser gives the media keys and the system's
  // player controls to whichever page is playing, and while a YouTube song plays that is this
  // one. The site's own Media Session would show its idea of the song and keep the keys for its
  // own queue; instead it shows what Tint says (do: 'session') and the keys go back to Tint.
  const session = window.tintBrowserHost && 'mediaSession' in navigator ? navigator.mediaSession : null;
  let describe = null;
  if (session) {
    const proto = Object.getPrototypeOf(session);
    const metadata = Object.getOwnPropertyDescriptor(proto, 'metadata');
    const playbackState = Object.getOwnPropertyDescriptor(proto, 'playbackState');
    const setHandler = session.setActionHandler.bind(session);
    Object.defineProperty(session, 'metadata', { get: () => metadata.get.call(session), set: () => {} });
    Object.defineProperty(session, 'playbackState', { get: () => playbackState.get.call(session), set: () => {} });
    session.setActionHandler = () => {};
    session.setPositionState = () => {};
    const pass = (name) => () => say({ is: 'command', name });
    setHandler('play', pass('play'));
    setHandler('pause', pass('pause'));
    setHandler('nexttrack', pass('next'));
    setHandler('previoustrack', pass('previous'));
    describe = (ask) => {
      const artwork = /^https:\/\//.test(ask.art || '') ? [{ src: ask.art, sizes: '320x320', type: 'image/jpeg' }] : [];
      metadata.set.call(session, ask.title ? new MediaMetadata({ title: ask.title, artist: ask.artist || '', album: ask.album || '', artwork }) : null);
      playbackState.set.call(session, !ask.title ? 'none' : ask.playing ? 'playing' : 'paused');
    };
  }

  let wanted = null;    // the song Tint asked for
  let seen = false;     // the player has got as far as loading it
  let finished = false; // and has played it to the end
  let told = '';
  let askedAt = 0;      // when the site was last asked to start it
  let asked = 0;        // and how many times
  let level = null;     // how loud Tint wants it, 0 to 100
  let holding = false;  // Tint asked for a pause
  let watching = 0;

  function monitor(on) {
    if (on && !watching) watching = setInterval(watch, 200);
    else if (!on && watching) { clearInterval(watching); watching = 0; }
  }

  // The site builds its player a moment after the page loads.
  const waiting = setInterval(() => {
    if (typeof player()?.getPlayerState !== 'function' || typeof app()?.handleNavigationEndpoint !== 'function') return;
    clearInterval(waiting);
    try { player().addEventListener('onError', (code) => { if (wanted) say({ is: 'error', id: wanted, code }); }); } catch { /* an older player: Tint's own timeout covers it */ }
    say({ is: 'ready' });
  }, 100);

  /** What the audio being played is, read from the list of formats YouTube offered for the song. */
  function format(p) {
    try {
      const itag = Number(p.getVideoStats().afmt);
      const offered = p.getPlayerResponse()?.streamingData?.adaptiveFormats?.find((f) => f.itag === itag);
      if (!offered) return null;
      return { codec: /opus/.test(offered.mimeType) ? 'Opus' : /mp4a/.test(offered.mimeType) ? 'AAC' : 'audio', kbps: Math.round((offered.averageBitrate || offered.bitrate) / 1000) };
    } catch {
      return null;
    }
  }

  function open(id) {
    asked++;
    askedAt = Date.now();
    app().handleNavigationEndpoint({ watchEndpoint: { videoId: id } });
  }

  function watch() {
    const p = player();
    if (!p || !wanted) return;
    const id = p.getVideoData()?.video_id;
    const state = p.getPlayerState(); // 1 playing, 2 paused, 3 buffering, 0 ended, -1 and 5 not started

    if (id !== wanted && !seen && asked < 4 && Date.now() - askedAt > 2500) {
      // Asked while it was busy (just after opening, say), the site can let a request drop. Ask again.
      open(wanted);
      return;
    }
    if (id !== wanted) {
      // After a song the site moves on to one it picked. That isn't Tint's next song, so hold it there.
      if (seen && id && (state === 1 || state === 3)) p.pauseVideo();
      if (seen && id && !finished) { finished = true; say({ is: 'ended', id: wanted }); }
      return;
    }
    seen = true;
    if (finished) return;
    // The site keeps a volume of its own and puts it back with each song. Tint's is the one that counts.
    if (level !== null && p.getVolume() !== level) p.setVolume(level);
    // With nobody having clicked in this page, the site loads a song and then waits to be told to play it.
    if ((state === -1 || state === 5) && !holding) p.playVideo();
    if (state === 0) {
      finished = true;
      monitor(false);
      say({ is: 'ended', id });
      return;
    }

    const now = {
      is: 'state', id,
      state: state === 1 ? 'playing' : state === 2 ? 'paused' : 'loading',
      time: Math.round(p.getCurrentTime() * 4) / 4,
      duration: Math.round(p.getDuration() || 0),
      format: state === 1 ? format(p) : null,
    };
    const text = JSON.stringify(now);
    if (text !== told) { told = text; say(now); }
  }

  window.chrome.webview.addEventListener('message', (event) => {
    const ask = event.data;
    if (ask?.to === 'youtube' && ask.do === 'session') {
      describe?.(ask);
      return;
    }
    const p = player();
    if (!ask || ask.to !== 'youtube' || !p) return;

    if (ask.do === 'load' && /^[A-Za-z0-9_-]{11}$/.test(ask.id)) {
      const again = p.getVideoData()?.video_id === ask.id;
      wanted = ask.id;
      seen = again;
      finished = false;
      holding = false;
      monitor(true);
      asked = 0;
      told = '';
      // The song that is already loaded (repeat, or the same one picked again) only needs rewinding.
      if (again) { p.seekTo(0, true); p.playVideo(); }
      else open(ask.id);
    } else if (ask.do === 'play') {
      // Playing a finished song again starts it over.
      if (finished && p.getVideoData()?.video_id === wanted) { finished = false; p.seekTo(0, true); }
      holding = false;
      monitor(true);
      p.playVideo();
    } else if (ask.do === 'pause') {
      holding = true;
      p.pauseVideo();
      monitor(false);
    } else if (ask.do === 'seek') {
      p.seekTo(Number(ask.at) || 0, true);
    } else if (ask.do === 'volume') {
      level = Math.round(Math.max(0, Math.min(1, Number(ask.level) || 0)) * 100);
      p.setVolume(level);
      if (level > 0) p.unMute(); else p.mute();
    } else if (ask.do === 'stop') {
      wanted = null;
      p.pauseVideo();
      monitor(false);
    }
    watch();
  });

  // The moment anything starts or stops, not a fifth of a second later.
  document.addEventListener('playing', watch, true);
  document.addEventListener('pause', watch, true);
  document.addEventListener('ended', watch, true);
})();
