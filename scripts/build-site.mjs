// Copies just the web app into ./site so it can be dragged onto a static host (Netlify Drop, Cloudflare Pages, etc.).
//   npm run build                                   solo mode (this device, optional Dropbox sync)
//   npm run build -- --url https://xxxx.supabase.co --key <anon public key> --name "My Clinic"     clinic mode
// (or set SUPABASE_URL / SUPABASE_ANON_KEY / CLINIC_NAME). The anon key is public by design; it grants nothing alone.
import { cpSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const args = process.argv.slice(2);
const arg = (n, env) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : process.env[env] || ''; };
const url = arg('url', 'SUPABASE_URL').replace(/\/+$/, ''), key = arg('key', 'SUPABASE_ANON_KEY'), name = arg('name', 'CLINIC_NAME');

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'site');
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const f of ['index.html', 'sw.js', 'manifest.webmanifest', 'css', 'js', 'icons']) cpSync(join(root, f), join(out, f), { recursive: true });

if (url || key) {
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)) { console.error('--url should look like https://abcdefgh.supabase.co (Supabase → Project Settings → API → Project URL)'); process.exit(1); }
  if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(key) && !/^sb_publishable_/.test(key)) { console.error('--key should be the "anon public" (or publishable) key, NOT the service_role / secret key.'); process.exit(1); }
  if (/service_role/.test(Buffer.from(key.split('.')[1] || '', 'base64url').toString())) { console.error('That is the service_role key — it must never go in a web app. Use the anon public key.'); process.exit(1); }
  writeFileSync(join(out, 'js', 'config.js'), `export const CLINIC = ${JSON.stringify({ supabaseUrl: url, anonKey: key, clinicName: name })};\n`);
  console.log(`Built ./site in CLINIC mode for ${url}`);
} else console.log('Built ./site in solo mode.');
console.log('Upload the ./site folder to your HTTPS static host.');
