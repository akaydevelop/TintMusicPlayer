// Research helper: finds the developer token Apple's web player ships with, and checks what the
// Apple Music API requires alongside it. Prints facts about the token, never the token itself.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const get = (url, headers = {}) => fetch(url, { headers: { 'User-Agent': UA, ...headers } });

const home = await (await get('https://music.apple.com/us/browse')).text();
const scripts = [...home.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
console.log('page bytes:', home.length, '| script files referenced:', scripts.length);
console.log(scripts.slice(0, 12).join('\n'));

const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/g;
let token = (home.match(JWT) || [])[0] || null;
let foundIn = token ? 'the page itself' : null;
for (const src of scripts.sort((a, b) => Number(b.includes('index')) - Number(a.includes('index')))) {
  if (token) break;
  const body = await (await get('https://music.apple.com' + src)).text();
  const hit = body.match(JWT);
  if (hit) { token = hit[0]; foundIn = src; }
}
if (!token) { console.log('NO TOKEN FOUND'); process.exit(1); }

const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString());
const [h, p] = token.split('.');
const claims = decode(p);
console.log('\nfound in:', foundIn);
console.log('header:', JSON.stringify(decode(h)));
console.log('claims:', JSON.stringify({ ...claims, exp: new Date(claims.exp * 1000).toISOString(), iat: new Date(claims.iat * 1000).toISOString() }));

for (const [label, extra] of [
  ['no Origin header', {}],
  ['Origin: http://127.0.0.1:47813', { Origin: 'http://127.0.0.1:47813' }],
  ['Origin: https://music.apple.com', { Origin: 'https://music.apple.com' }],
]) {
  for (const host of ['api.music.apple.com', 'amp-api.music.apple.com']) {
    const res = await get(`https://${host}/v1/catalog/us/search?term=natori&types=songs&limit=1`, { Authorization: 'Bearer ' + token, ...extra });
    console.log(`${host} | ${label} -> ${res.status} | allow-origin: ${res.headers.get('access-control-allow-origin')}`);
  }
}
