// Copies just the web app into ./site so it can be dragged onto a static host (Netlify Drop, Cloudflare Pages, etc.).
import { cpSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'site');
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const f of ['index.html', 'sw.js', 'manifest.webmanifest', 'css', 'js', 'icons']) cpSync(join(root, f), join(out, f), { recursive: true });
console.log('Built ./site — upload that folder to your HTTPS static host.');
