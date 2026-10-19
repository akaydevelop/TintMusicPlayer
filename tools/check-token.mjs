// Checks the developer-token signing end to end with a throwaway key (never a real Apple key).
//   node tools/check-token.mjs make <dir>     writes <dir>/AuthKey_TESTKEY123.p8 and <dir>/public.pem
//   node tools/check-token.mjs verify <dir>   asks the running app for a token and verifies its signature

import { generateKeyPairSync, verify, createPublicKey } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [mode, dir] = process.argv.slice(2);

if (mode === 'make') {
  mkdirSync(dir, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  writeFileSync(join(dir, 'AuthKey_TESTKEY123.p8'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
  writeFileSync(join(dir, 'public.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
  console.log('made a throwaway key in', dir);
} else if (mode === 'verify') {
  const { token, error } = await (await fetch('http://127.0.0.1:47813/api/apple-token')).json();
  if (!token) throw new Error('The app returned no token: ' + error);
  const [head, body, signature] = token.split('.');
  const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString());
  const ok = verify('sha256', Buffer.from(`${head}.${body}`),
    { key: createPublicKey(readFileSync(join(dir, 'public.pem'))), dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url'));
  const claims = decode(body);
  console.log(JSON.stringify({ header: decode(head), claims, days: (claims.exp - claims.iat) / 86400, signatureValid: ok }, null, 2));
  if (!ok) process.exit(1);
} else {
  console.error('usage: node tools/check-token.mjs make|verify <dir>');
  process.exit(2);
}
