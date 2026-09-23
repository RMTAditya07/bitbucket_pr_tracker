// Exchange a Zoho Self Client grant code for a refresh token and store it in .env.
//   npm run zoho:token -- <grant code>
import { readFileSync, writeFileSync } from 'node:fs';

const code = process.argv[2]?.trim();
if (!code) {
  console.error('Usage: npm run zoho:token -- <grant code from api-console "Generate Code">');
  process.exit(2);
}
process.loadEnvFile('.env');
const accounts = (process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com').replace(/\/+$/, '');

const res = await fetch(`${accounts}/oauth/v2/token`, {
  method: 'POST',
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: process.env.ZOHO_CLIENT_ID.trim(),
    client_secret: process.env.ZOHO_CLIENT_SECRET.trim(),
    code,
  }),
});
const body = await res.json();
if (!body.refresh_token) {
  console.error(`Exchange failed: ${body.error ?? `HTTP ${res.status}`}`);
  if (body.error === 'invalid_code') console.error('The code expired (10 min) or was already used — generate a new one.');
  process.exit(1);
}

const env = readFileSync('.env', 'utf8');
const line = `ZOHO_REFRESH_TOKEN=${body.refresh_token}`;
writeFileSync('.env', /^ZOHO_REFRESH_TOKEN=.*$/m.test(env) ? env.replace(/^ZOHO_REFRESH_TOKEN=.*$/m, line) : `${env}\n${line}\n`);
console.log(`Saved refresh token to .env (scope: ${body.scope ?? 'n/a'}, api_domain: ${body.api_domain ?? 'n/a'})`);
