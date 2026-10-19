// This file does not run as part of Tint's page. The Chrome-hosted build (src/Chrome) puts it into
// every page it drives, ahead of the page's own scripts, to give them the messaging WebView2 gives
// the Windows build: window.chrome.webview.postMessage to the host, and 'message' events from it.
// The host's half is a DevTools binding (__tintSay) one way, and a call to __tintHear the other.

(() => {
  if (window.top !== window || window.chrome?.webview || typeof window.__tintSay !== 'function') return;
  const say = window.__tintSay;
  const listeners = new Set();

  const webview = {
    postMessage: (message) => say(JSON.stringify(message)),
    addEventListener: (type, listener) => { if (type === 'message') listeners.add(listener); },
    removeEventListener: (type, listener) => { if (type === 'message') listeners.delete(listener); },
  };

  Object.defineProperty(window, '__tintHear', {
    value: (data) => {
      for (const listener of listeners) {
        try { listener({ data }); } catch (e) { console.error(e); }
      }
    },
  });

  window.chrome = window.chrome || {};
  Object.defineProperty(window.chrome, 'webview', { value: webview });
  // Tells the page which host it is in: the media keys and the system's player controls come from
  // the browser's own Media Session here, not from the host (see system.js).
  Object.defineProperty(window, 'tintBrowserHost', { value: true });
})();
