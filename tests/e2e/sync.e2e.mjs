// Two-device sync test. Needs: the app served on :8080 (node serve.mjs) and Playwright installed.
//   PW_MODULES=/path/to/node_modules/ node tests/e2e/sync.e2e.mjs
import { createRequire } from 'module';
import { startMock } from './mock-dropbox.mjs';
const require = createRequire(process.env.PW_MODULES || '/node-tools/node_modules/');
const { chromium } = require('playwright');

const APP = 'http://localhost:8080/', DBX = 'http://localhost:9090';
const PW = 'alice has a long password';
const mock = await startMock(9090);
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const errors = [];
let revoked = false;
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };

async function device(name) {
  const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 900, height: 900 } });
  await ctx.addInitScript((b) => { try { localStorage.setItem('physio-dbx-base', b); } catch {} }, DBX);
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => !revoked && errors.push(`${name} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !revoked && !/status of (40[149]|409)/.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
  return { ctx, page, name };
}
const synced = (page) => page.waitForFunction(() => /Synced/.test(document.getElementById('syncChip')?.textContent || '') && !document.getElementById('syncChip').hidden, null, { timeout: 20000 });
const syncNow = async (page) => { await page.click('#syncChip'); await page.waitForTimeout(300); await synced(page); };
const state = async () => (await fetch(DBX + '/__state')).json();
const login = async (page, user = 'alice') => { await page.fill('#username', user); await page.fill('#password', PW); await page.click('#go'); await page.waitForSelector('#lockBtn'); };

const laptop = await device('laptop'), phone = await device('phone');
const L = laptop.page, P = phone.page;
await fetch(DBX + '/__expires?s=30'); // access tokens are always "expired": exercises the refresh-token path on every call

// ===== laptop: create account + data, then connect Dropbox =====
await L.goto(APP);
await L.fill('#displayName', 'Alice Park'); await L.fill('#username', 'alice'); await L.fill('#password', PW); await L.fill('#password2', PW);
await L.click('#go'); await L.waitForSelector('#rk'); await L.check('#saved'); await L.click('#cont'); await L.waitForSelector('#lockBtn');
await L.click('text=+ New patient');
await L.fill('#firstName', 'Jane'); await L.fill('#lastName', 'Doe'); await L.fill('#condition', 'Rotator cuff'); await L.click('text=Save patient'); await L.waitForSelector('text=Jane Doe');
await L.click('text=+ Initial assessment');
await L.click('[data-chips=pain] [data-n="7"]'); await L.fill('#subjective', 'SECRET-SYNC-1 reaching pain');
await L.click('#recBtn'); await L.waitForTimeout(1500); await L.click('#recBtn'); await L.waitForSelector('.clip audio');
await L.click('#finishBtn'); await L.waitForSelector('text=Visit history');

await L.goto(APP + '#/settings');
ok(await L.isVisible('text=One-time Dropbox setup'), 'settings shows Dropbox setup instructions');
await L.fill('#appKey', 'testappkey'); await L.click('#dbxConnect');
await L.waitForSelector('text=Dropbox is authorized');
ok(true, 'returned from Dropbox sign-in (PKCE) to the sign-in screen');
await login(L); await synced(L);
ok(true, 'laptop connected and synced');

let st = await state();
const paths = st.files.map((f) => f.path);
ok(paths.some((p) => p.endsWith('/account.json')) && paths.filter((p) => /\/v\//.test(p)).length === 1 && paths.filter((p) => /\/a\//.test(p)).length === 1 && paths.filter((p) => /\/p\//.test(p)).length === 1, 'Dropbox has account.json + 1 patient, 1 visit, 1 audio file');
const blob = st.files.map((f) => f.body).join('\n');
const LEAK = /Jane|SECRET-SYNC|Rotator cuff|reaching pain|LAPTOP EDIT|PHONE EDIT|LAST-MINUTE|PHONE-PLAN/;
ok(!LEAK.test(blob), 'files in Dropbox contain NO readable patient data: ' + (blob.match(LEAK) || ['none'])[0]);
ok(st.calls.filter((c) => c.includes('/oauth2/token')).length > 3, 'refresh-token flow exercised repeatedly');

// ===== phone: brand-new device, set up from Dropbox =====
await P.goto(APP);
await P.click('#toDevice'); await P.fill('#appkey', 'testappkey'); await P.click('button:has-text("Connect Dropbox")');
await P.waitForSelector('text=Choose your account');
await P.click('.pick:has-text("Alice Park")'); await P.waitForSelector('text=Account added');
await login(P); await synced(P);
await P.waitForSelector('.pitem:has-text("Jane Doe")', { timeout: 10000 });
ok(true, 'phone shows the patient created on the laptop');
await P.click('.pitem:has-text("Jane Doe")'); await P.waitForSelector('text=SECRET-SYNC-1');
ok(true, 'phone shows the visit note text, decrypted with the same password');
await P.click('a:has-text("Open / edit")'); await P.waitForSelector('.clip audio');
ok(await P.locator('.clip audio').count() === 1, 'voice recording synced to the phone');
await P.goBack(); await P.waitForSelector('text=Visit history');

// ===== phone adds a follow-up; laptop receives it =====
await P.click('text=+ Follow-up visit'); await P.click('[data-chips=pain] [data-n="4"]'); await P.fill('#plan', 'PHONE-PLAN progress loading');
await P.click('#finishBtn'); await P.waitForSelector('text=Visit history'); await syncNow(P);
await L.goto(APP + '#/'); await syncNow(L);
await L.click('.pitem:has-text("Jane Doe")'); await L.waitForSelector('text=PHONE-PLAN');
ok(await L.locator('.visit').count() === 2, 'follow-up added on phone appears on laptop');

// ===== conflict: same visit edited on both devices while offline =====
const firstVisitHref = async (page) => (await page.locator('a:has-text("Open / edit")').last().getAttribute('href'));
const href = await firstVisitHref(L);
await P.goto(APP + '#/'); await P.click('.pitem:has-text("Jane Doe")'); await P.waitForSelector('text=Visit history');
await L.context().setOffline(true); await P.context().setOffline(true);
await L.goto(APP + href); await L.fill('#subjective', 'LAPTOP EDIT offline'); await L.waitForTimeout(1500);
await P.goto(APP + href); await P.fill('#subjective', 'PHONE EDIT offline'); await P.waitForTimeout(1500);
await L.goto(APP + '#/'); await P.goto(APP + '#/');
await L.waitForFunction(() => /Offline/.test(document.getElementById('syncChip')?.textContent || ''));
ok(true, 'offline: devices keep working and show Offline');
await P.context().setOffline(false); await syncNow(P);
await L.context().setOffline(false); await syncNow(L);
await P.goto(APP + '#/'); await syncNow(P);
for (const [n, pg] of [['laptop', L], ['phone', P]]) {
  await pg.goto(APP + '#/'); await pg.click('.pitem:has-text("Jane Doe")'); await pg.waitForSelector('text=Visit history');
  const t = await pg.textContent('main');
  ok(/LAPTOP EDIT/.test(t) && /PHONE EDIT/.test(t), `${n}: BOTH offline edits survive (no data lost)`);
  ok(/Conflict copy/.test(t), `${n}: one version is flagged as a conflict copy`);
}

// ===== delete propagates =====
await L.click('a:has-text("Open / edit") >> nth=0'); await L.waitForSelector('#delVisit');
const before = (await state()).files.filter((f) => /\/v\//.test(f.path)).length;
await L.click('#delVisit'); await L.waitForSelector('text=Visit history'); await syncNow(L);
ok((await state()).files.filter((f) => /\/v\//.test(f.path)).length === before - 1, 'deleting a visit on the laptop deletes the cloud copy');
await P.goto(APP + '#/'); await syncNow(P); await P.click('.pitem:has-text("Jane Doe")'); await P.waitForSelector('text=Visit history');
ok(await P.locator('.visit').count() === (await L.locator('.visit').count()), 'phone converges with laptop after the delete');

// ===== edit right before signing out is not lost =====
const v2 = await P.locator('a:has-text("Open / edit")').last().getAttribute('href');
await P.goto(APP + v2); await P.fill('#objective', 'LAST-MINUTE edit before sign out');
await P.click('#outBtn'); await P.waitForSelector('text=Welcome back');
await L.goto(APP + '#/'); await syncNow(L); await L.goto(APP + v2);
ok((await L.inputValue('#objective')) === 'LAST-MINUTE edit before sign out', 'sign-out flushed the last edit to Dropbox first');

// ===== still encrypted in Dropbox after all of that =====
const all = (await state()).files.map((f) => f.body).join('\n');
ok(!LEAK.test(all), 'after everything, Dropbox still holds only ciphertext: ' + (all.match(LEAK) || ['none'])[0]);

// ===== revoked access is reported, not silent =====
revoked = true; await fetch(DBX + '/__revoke');
await L.goto(APP + '#/'); await L.click('#syncChip');
await L.waitForFunction(() => /Sync issue/.test(document.getElementById('syncChip')?.textContent || ''), null, { timeout: 15000 });
ok(true, 'revoked Dropbox access shows a visible sync problem');
await L.screenshot({ path: process.env.SHOT || '/tmp/sync-laptop.png' });
ok(errors.length === 0, 'no unexpected console/page errors ' + JSON.stringify(errors));
await browser.close(); mock.close();
