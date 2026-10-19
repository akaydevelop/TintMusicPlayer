// Runs a JavaScript expression inside the running app (started with --dev) and prints the result.
//   node tools/eval.mjs "document.title"
// Used for scripted checks of the real WebView2 window rather than a stand-in browser.

const expression = process.argv[2];
if (!expression) {
  console.error('usage: node tools/eval.mjs "<expression>"');
  process.exit(2);
}

const targets = await (await fetch('http://127.0.0.1:9229/json')).json();
const page = targets.find((t) => t.type === 'page' && (t.url.startsWith('https://music.apple.com/tint/') || t.url.startsWith('http://127.0.0.1:478')));
if (!page) {
  console.error('The Tint page was not found. Is it running with --dev?');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
ws.send(JSON.stringify({
  id: 1,
  method: 'Runtime.evaluate',
  params: { expression, awaitPromise: true, returnByValue: true, userGesture: true },
}));
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== 1) return;
  const { result, exceptionDetails } = message.result;
  if (exceptionDetails) {
    console.error('threw:', exceptionDetails.exception?.description || exceptionDetails.text);
    process.exitCode = 1;
  } else {
    console.log(typeof result.value === 'string' ? result.value : JSON.stringify(result.value, null, 2));
  }
  ws.close();
};
