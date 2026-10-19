// Like eval.mjs, but also reports what the page did on the network and wrote to the console
// while the expression ran. For working out why something in the page fails.
//   node tools/trace.mjs "<expression>" [urlFilterRegex]

const expression = process.argv[2];
const filter = new RegExp(process.argv[3] || '.', 'i');
if (!expression) {
  console.error('usage: node tools/trace.mjs "<expression>" [urlFilterRegex]');
  process.exit(2);
}

const targets = await (await fetch('http://127.0.0.1:9229/json')).json();
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('https://music.apple.com/tint/'));
if (!page) {
  console.error('The Tint page was not found. Is it running with --dev?');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

let nextId = 1;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});

const requests = new Map();
const lines = [];
const short = (url) => url.replace(/\?.*$/, (q) => (q.length > 60 ? q.slice(0, 60) + '…' : q)).slice(0, 150);

ws.onmessage = async (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    pending.get(message.id)?.(message.result ?? message);
    pending.delete(message.id);
    return;
  }
  const p = message.params;
  switch (message.method) {
    case 'Network.requestWillBeSent':
      requests.set(p.requestId, { url: p.request.url, method: p.request.method });
      break;
    case 'Network.responseReceived': {
      const r = requests.get(p.requestId);
      if (r && filter.test(r.url)) {
        r.status = p.response.status;
        lines.push(`${p.response.status} ${r.method} ${short(r.url)}`);
        // Apple explains refusals in the response body, so keep those.
        if (p.response.status >= 400 || /license|play\/assets|webPlayback/i.test(r.url)) r.wantBody = true;
      }
      break;
    }
    case 'Network.loadingFinished': {
      const r = requests.get(p.requestId);
      if (r?.wantBody) {
        const body = await send('Network.getResponseBody', { requestId: p.requestId });
        // Never print long opaque values (keys, tokens, licences): only their shape.
        const text = String(body.body || '').replace(/"([A-Za-z0-9+/=_-]{80,})"/g, (_, v) => `"<${v.length} chars>"`);
        lines.push(`   body of ${short(r.url)}: ${text.slice(0, 600)}`);
      }
      break;
    }
    case 'Network.loadingFailed': {
      const r = requests.get(p.requestId);
      if (r && filter.test(r.url)) lines.push(`FAILED ${r.method} ${short(r.url)}: ${p.errorText}${p.blockedReason ? ' (' + p.blockedReason + ')' : ''}`);
      break;
    }
    case 'Runtime.consoleAPICalled':
      if (['error', 'warning'].includes(p.type)) {
        lines.push(`console.${p.type}: ` + p.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 400));
      }
      break;
    case 'Runtime.exceptionThrown':
      lines.push('uncaught: ' + (p.exceptionDetails.exception?.description || p.exceptionDetails.text).slice(0, 400));
      break;
  }
};

await send('Network.enable');
await send('Runtime.enable');
// A page promise that never settles shouldn't hide everything seen so far.
const deadline = new Promise((resolve) => setTimeout(() => resolve({ result: { value: '(no result after 45 s: the expression never finished)' } }), 45000));
const result = await Promise.race([
  send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }),
  deadline,
]);
await new Promise((r) => setTimeout(r, 800));

console.log(lines.join('\n'));
console.log('--- result');
if (result.exceptionDetails) console.log('threw:', result.exceptionDetails.exception?.description || result.exceptionDetails.text);
else console.log(typeof result.result?.value === 'string' ? result.result.value : JSON.stringify(result.result?.value, null, 2));
ws.close();
process.exit(0);
