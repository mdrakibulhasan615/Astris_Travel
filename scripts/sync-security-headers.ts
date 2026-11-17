/**
 * Copies the production security headers (server/security/headers.ts) into vercel.json, where the
 * CDN applies them to the static build. Run after changing a CSP source: `npm run headers:sync`.
 * server/security.test.ts fails while the two disagree.
 */
import fs from 'node:fs';
import { securityHeaderValues } from '../server/security/headers.ts';

const file = new URL('../vercel.json', import.meta.url);
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
config.headers = [
  {
    source: '/(.*)',
    headers: Object.entries(securityHeaderValues({ production: true })).map(([key, value]) => ({ key, value })),
  },
];
fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
console.log('vercel.json headers updated');
