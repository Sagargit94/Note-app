import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ready-to-upload/ is what people drag onto a static host. It must mirror the source and contain no package.json
// (hosts would otherwise try to "build" it). Regenerate with:  npm run build
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const out = join(root, 'ready-to-upload');
const walk = (d, base = d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f), base) : [join(d, f).slice(base.length + 1)]));

test('ready-to-upload mirrors the app source (except js/config.js) and has no build files', () => {
  assert.ok(existsSync(join(out, 'index.html')), 'run `npm run build` to regenerate ready-to-upload/');
  assert.ok(!existsSync(join(out, 'package.json')));
  for (const f of walk(out)) {
    if (f === 'js/config.js') continue;
    assert.equal(readFileSync(join(out, f), 'utf8'), readFileSync(join(root, f), 'utf8'), `${f} is out of date — run npm run build`);
  }
  for (const f of [...walk(join(root, 'js'), root), ...walk(join(root, 'css'), root), 'index.html', 'sw.js', 'manifest.webmanifest']) {
    assert.ok(existsSync(join(out, f)), `${f} missing from ready-to-upload`);
  }
});
