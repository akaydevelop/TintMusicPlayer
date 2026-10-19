// Talks to the Windows host that serves this page.

// Addresses are resolved against the page's own folder rather than the site root, because the
// page does not always live at the root (see PageBridge in the host).
const resolve = (path) => path.replace(/^\//, '');

async function request(path, options) {
  const res = await fetch(resolve(path), options);
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}

export const get = (path) => request(path);

export const post = (path, body) => request(path, {
  method: 'POST',
  // The host refuses writes without this header, which other websites can't send to it.
  headers: { 'X-Tint': '1', 'Content-Type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});
