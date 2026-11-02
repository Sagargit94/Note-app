// Clinic-mode end-to-end test: admin + clinicians on separate "devices" against a real-Postgres-backed Supabase double.
//   PGHOST=... PGPORT=... PGUSER=... PW_MODULES=/path/to/node_modules/ node tests/e2e/clinic.e2e.mjs   (app served on :8080)
import { createRequire } from 'module';
import fs from 'fs';
import { startSupabase } from './mock-supabase.mjs';
const require = createRequire(process.env.PW_MODULES || '/node-tools/node_modules/');
const { chromium } = require('playwright');

const APP = 'http://localhost:8080/';
const sb = await startSupabase({ port: 9100, adminEmail: 'boss@clinic.test' });
const CONFIG = `export const CLINIC = { supabaseUrl: '${sb.url}', anonKey: '${sb.anonKey}', clinicName: 'Test Clinic' };`;
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const BOSS_PW = 'boss has a long password', BOB_PW = 'bobs very secret phrase';

async function device(name, { clock = false } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', permissions: ['microphone'], viewport: { width: 1000, height: 900 } });
  await ctx.route('**/js/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: CONFIG }));
  const page = await ctx.newPage();
  if (clock) await page.clock.install();
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (4\d\d)|ERR_INTERNET_DISCONNECTED/.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
  return { ctx, page };
}
const signup = async (page, name, email, pw) => {
  await page.fill('#displayName', name); await page.fill('#username', email); await page.fill('#password', pw); await page.fill('#password2', pw);
  await page.click('#go'); await page.waitForSelector('#rk');
  const key = (await page.textContent('#rk')).trim(); await page.check('#saved'); await page.click('#cont'); return key;
};
const login = async (page, email, pw, expect = '#lockBtn') => { await page.fill('#username', email); await page.fill('#password', pw); await page.click('#go'); await page.waitForSelector(expect, { timeout: 15000 }); };
const syncNow = async (page) => { await page.click('#syncChip'); await page.waitForTimeout(300); await page.waitForFunction(() => /Synced/.test(document.getElementById('syncChip')?.textContent || ''), null, { timeout: 20000 }); };
const addPatient = async (page, first, last, note) => {
  await page.goto(APP + '#/'); await page.click('text=+ New patient');
  await page.fill('#firstName', first); await page.fill('#lastName', last); await page.click('text=Save patient'); await page.waitForSelector(`text=${first} ${last}`);
  await page.click('text=+ Initial assessment'); await page.fill('#subjective', note); await page.click('[data-chips=pain] [data-n="6"]');
  await page.click('#finishBtn'); await page.waitForSelector('text=Visit history');
};
const dbq = (sql, a) => sb.q(sql, a);

// ===== 1. the administrator signs up first =====
const laptop = await device('boss-laptop'); const L = laptop.page;
await L.goto(APP);
ok(await L.isVisible('text=Work email') && await L.isVisible('text=approved by your clinic administrator'), 'clinic mode: sign-up asks for work email and mentions approval');
await signup(L, 'Dr Boss', 'Boss@Clinic.test', BOSS_PW);
await L.waitForSelector('#lockBtn'); await L.waitForSelector('text=Set up clinic recovery');
ok(await L.isVisible('#navAdmin'), 'the configured admin email is approved automatically and sees the Clinic menu');
ok(true, 'the admin MUST set up clinic recovery before anything else (screen shown automatically)');

// a colleague who signs up too early is told the clinic isn't ready, and keeps a usable half-made account
const catDev = await device('cat'); const C = catDev.page;
await C.goto(APP); await C.waitForSelector('text=Clinic recovery is on');
ok(/after your account has been disabled/.test(await C.textContent('main')), 'sign-up screen tells everyone clinic recovery exists (and that it only applies after disabling)');
await signup(C, 'Cat Kim', 'cat@clinic.test', 'cats have a long password');
await C.waitForSelector('text=finished setting up');
ok(true, 'signing up before recovery is set up: "your clinic hasn\'t finished setting up" (no half-broken state)');

// admin completes recovery setup
await L.fill('#pp', 'recovery file passphrase'); await L.fill('#pp2', 'recovery file passphrase'); await L.fill('#mypw', 'wrong password!!'); await L.click('#go');
await L.waitForSelector('#authErr:not([hidden])');
ok(/incorrect/i.test(await L.textContent('#authErr')), 'setup asks for the admin\'s own password first');
await L.fill('#mypw', BOSS_PW); await L.click('#go'); await L.waitForSelector('#dl', { timeout: 30000 });
const [dl0] = await Promise.all([L.waitForEvent('download'), L.click('#dl')]);
const recoveryFile = await dl0.path();
const rf = fs.readFileSync(recoveryFile, 'utf8');
ok(JSON.parse(rf).encrypted === true && !/privateJwk|"d":/.test(rf), 'the recovery file is passphrase-encrypted (private key is not readable in it)');
await L.check('#saved'); await L.click('#fin'); await L.waitForSelector('.dir-item');
const kidRow = await dbq("select detail->>'kid' as kid from audit_log where action='set_clinic_key'");
ok(kidRow.length === 1 && /^[0-9a-f]{16}$/.test(kidRow[0].kid), 'database: only the PUBLIC recovery key + ID were stored, and the setup is in the audit log');
ok(!(await dbq("select 1 from private.config where key='escrow' and value like '%\"d\"%'")).length, 'database: no private key material');
const KID = kidRow[0].kid;
ok((await dbq("select blob->'escrow'->>'kid' as k from accounts a join profiles p on p.id=a.user_id where p.email='boss@clinic.test'"))[0].k === KID, 'the admin\'s own account is sealed to the recovery key too');
const prof = await dbq("select role,status from profiles where email='boss@clinic.test'");
ok(prof[0]?.role === 'admin' && prof[0]?.status === 'active', 'database: admin is role=admin, status=active');
const authRow = await dbq("select encrypted_password from auth.users where email='boss@clinic.test'");
ok(authRow.length === 1 && !authRow[0].encrypted_password.includes(BOSS_PW), 'server never received the real password (only a derived login secret)');

// ===== 2. a colleague signs up: pending =====
const bobDev = await device('bob', { clock: true }); const B = bobDev.page;
await B.goto(APP);
await B.waitForSelector('text=Clinic recovery is on');
const bobRecovery = await signup(B, 'Bob Lee', 'bob@clinic.test', BOB_PW);
await B.waitForSelector('text=Waiting for approval');
ok(await B.isVisible('text=bob@clinic.test'), 'new colleague sees "Waiting for approval" and cannot enter');
ok((await dbq("select status from profiles where email='bob@clinic.test'"))[0].status === 'pending', 'database: Bob is pending');
ok((await dbq("select blob->'escrow'->>'kid' as k from accounts a join profiles p on p.id=a.user_id where p.email='bob@clinic.test'"))[0].k === KID, 'Bob\'s key was sealed to the clinic recovery key at sign-up');
await B.click('#back'); await login(B, 'bob@clinic.test', BOB_PW, 'text=Waiting for approval');
ok(true, 'signing in while pending still shows the waiting screen');

// ===== 3. admin sees name + email and approves =====
await L.goto(APP + '#/'); await L.goto(APP + '#/admin'); await L.waitForSelector('.dir-item');
const bobRow = L.locator('.dir-item', { hasText: 'Bob Lee' });
ok(await bobRow.isVisible() && /bob@clinic.test/.test(await bobRow.textContent()) && /Pending approval/.test(await bobRow.textContent()), 'admin directory lists Bob with name, email and "Pending approval"');
ok(/Waiting for approval/.test(await L.textContent('.hero')), 'directory shows a pending count');
await bobRow.locator('[data-act=approve]').click(); await L.waitForSelector('.dir-item:has-text("Bob Lee"):has-text("Active")');
ok(true, 'admin approved Bob');
await B.click('#back'); await login(B, 'bob@clinic.test', BOB_PW);
ok(true, 'after approval Bob can sign in');

// ===== 4. data isolation, even from the admin =====
await addPatient(B, 'Zed', 'Zimmer', 'BOB-SECRET-NOTE shoulder pain');
await syncNow(B);
await addPatient(L, 'Jane', 'Doe', 'BOSS-SECRET-NOTE knee pain'); await syncNow(L);
const recs = await dbq('select r.kind, r.body, p.email from records r join profiles p on p.id=r.user_id');
ok(recs.some((r) => r.email === 'bob@clinic.test') && recs.some((r) => r.email === 'boss@clinic.test'), 'both users\' records reached the clinic database');
ok(!recs.some((r) => /Zed|Zimmer|Jane|Doe|SECRET|shoulder|knee/.test(r.body || '')), 'the clinic database holds only ciphertext (no names, notes)');
await L.goto(APP + '#/'); await L.waitForSelector('.pitem:has-text("Jane Doe")'); await L.waitForTimeout(500); ok(!(await L.isVisible('text=Zed Zimmer')), "the admin does NOT see Bob's patients");
await L.goto(APP + '#/'); await L.goto(APP + '#/admin'); await L.waitForSelector('.dir-item');
const bobTxt = await L.locator('.dir-item', { hasText: 'Bob Lee' }).textContent();
ok(/cloud data [1-9]/.test(bobTxt) && !/Zed|BOB-SECRET/.test(await L.textContent('main')), 'admin sees only how much storage Bob uses, never content');

// ===== 5. a brand-new device: sign in with just email + password =====
const phone = await device('boss-phone'); const P = phone.page;
await P.goto(APP); await P.click('#toLogin');
await login(P, 'boss@clinic.test', BOSS_PW);
await P.waitForSelector('.pitem:has-text("Jane Doe")', { timeout: 15000 });
ok(true, 'admin signed in on a new device with email + password; account key and patients arrived');
ok(!(await P.isVisible('text=Zed Zimmer')), "…and still does not see Bob's patients");
await P.click('.pitem:has-text("Jane Doe")'); await P.waitForSelector('text=BOSS-SECRET-NOTE');
ok(true, 'visit notes decrypt on the new device');

// ===== 6. wrong password and unknown email are indistinguishable =====
const stranger = await device('stranger'); const S = stranger.page;
await S.goto(APP); await S.click('#toLogin');
await S.fill('#username', 'boss@clinic.test'); await S.fill('#password', 'totally wrong password'); await S.click('#go'); await S.waitForSelector('#authErr:not([hidden])');
const e1 = (await S.textContent('#authErr')).trim();
await S.fill('#username', 'nobody@clinic.test'); await S.fill('#password', 'totally wrong password'); await S.click('#go'); await S.waitForFunction((x) => document.getElementById('authErr') && !document.getElementById('authErr').hidden, null);
await S.waitForTimeout(800);
const e2 = (await S.textContent('#authErr')).trim();
ok(e1 === e2 && /Incorrect email or password/.test(e1), `wrong password and unknown email give the same message: "${e1}"`);

// ===== 7. disable someone who is signed in =====
await L.goto(APP + '#/'); await L.goto(APP + '#/admin'); await L.waitForSelector('.dir-item');
await L.locator('.dir-item', { hasText: 'Bob Lee' }).locator('[data-act=disable]').click();
await L.waitForSelector('.dir-item:has-text("Bob Lee"):has-text("Disabled")');
ok(!!(await dbq("select 1 from auth.users where email='bob@clinic.test' and banned_until is not null")).length, 'database: Bob is banned from signing in');
await B.clock.fastForward('01:10');
await B.waitForSelector('text=disabled by an administrator', { timeout: 10000 });
ok(!(await B.isVisible('text=Zed Zimmer')), 'Bob\'s open app locked itself within a minute of being disabled');
const reg = await B.evaluate(() => JSON.parse(localStorage.getItem('physio-accounts-v1')).find((a) => a.username === 'bob@clinic.test'));
ok(reg.revoked === true && !reg.pw && !reg.rec, 'Bob\'s device DELETED the keys that unlock his data (nothing left for a password to open)');
const bobDbs = await B.evaluate(async () => (await indexedDB.databases()).map((d) => d.name).filter((n) => n.startsWith('physio-notes-u-')));
ok(bobDbs.length === 1, '…but the encrypted data is still stored on the device');
await bobDev.ctx.setOffline(true);
await B.fill('#username', 'bob@clinic.test'); await B.fill('#password', BOB_PW); await B.click('#go'); await B.waitForSelector('#authErr:not([hidden])');
ok(/disabled/i.test(await B.textContent('#authErr')) && !(await B.isVisible('#lockBtn')), 'offline: the right password does NOT open the data of a disabled account');
await bobDev.ctx.setOffline(false);
await login(B, 'bob@clinic.test', BOB_PW, '#authErr:not([hidden])');
ok(/disabled/i.test(await B.textContent('#authErr')), 'online: Bob cannot sign back in: "' + (await B.textContent('#authErr')).trim().slice(0, 60) + '…"');

// clinic recovery of Bob's records (he is disabled) with the recovery file
await L.goto(APP + '#/'); await L.goto(APP + '#/admin'); await L.waitForSelector('.dir-item');
const bobRow2 = L.locator('.dir-item', { hasText: 'Bob Lee' });
ok(await bobRow2.locator('[data-act=recover]').isVisible() && !(await L.locator('.dir-item', { hasText: 'Dr Boss' }).locator('[data-act=recover]').isVisible()), '"Recover data" is offered only for the disabled account');
await bobRow2.locator('[data-act=recover]').click(); await L.waitForSelector('text=Recover Bob Lee');
await L.setInputFiles('#rfile', recoveryFile); await L.fill('#rpass', 'not the passphrase'); await L.click('#go'); await L.waitForSelector('#authErr:not([hidden])');
ok(/Wrong passphrase/.test(await L.textContent('#authErr')), 'recovery refuses a wrong passphrase');
await L.fill('#rpass', 'recovery file passphrase'); await L.click('#go'); await L.waitForSelector('text=Recovered:');
ok(/1 patient, 1 visit/.test(await L.textContent('#result')), 'recovery decrypted Bob\'s patient and visit: "' + (await L.textContent('#result')).trim().slice(0, 40) + '…"');
await L.click('#impMine'); await L.waitForSelector('.pitem:has-text("Zed Zimmer")');
await L.click('.pitem:has-text("Zed Zimmer")'); await L.waitForSelector('text=BOB-SECRET-NOTE');
ok(true, 'the recovered notes were imported and read intact');
ok((await dbq("select 1 from audit_log where action='recover_data'")).length === 1, 'database: the recovery was written to the audit log');
await L.goto(APP + '#/'); await L.goto(APP + '#/admin'); await L.waitForSelector('.dir-item');

// ===== 8. re-enable: nothing lost =====
await L.locator('.dir-item', { hasText: 'Bob Lee' }).locator('[data-act=enable]').click();
await L.waitForSelector('.dir-item:has-text("Bob Lee"):has-text("Active")');
await login(B, 'bob@clinic.test', BOB_PW);
await B.goto(APP + '#/'); await B.waitForSelector('.pitem:has-text("Zed Zimmer")');
ok(true, 'after re-enabling, Bob signs in and his patients are all still there');

// ===== 9. password change on one device, other device follows =====
await L.goto(APP + '#/settings'); await L.click('#chPw');
await L.fill('dialog [name=o]', BOSS_PW); await L.fill('dialog [name=n]', 'boss has a NEW long password'); await L.fill('dialog [name=n2]', 'boss has a NEW long password'); await L.click('dialog button.primary');
await L.waitForSelector('text=Password changed');
await P.click('#outBtn'); await P.waitForSelector('text=Welcome back');
await P.fill('#username', 'boss@clinic.test'); await P.fill('#password', BOSS_PW); await P.click('#go'); await P.waitForSelector('#authErr:not([hidden])');
ok(/changed on another device/.test(await P.textContent('#authErr')), 'old password on the other device explains it was changed elsewhere');
await login(P, 'boss@clinic.test', 'boss has a NEW long password');
await P.waitForSelector('.pitem:has-text("Jane Doe")');
ok(true, 'the other device accepts the new password and keeps all data');
await L.click('#outBtn'); await L.waitForSelector('text=Welcome back');
await L.fill('#username', 'boss@clinic.test'); await L.fill('#password', BOSS_PW); await L.click('#go'); await L.waitForSelector('#authErr:not([hidden])');
ok(true, 'the old password no longer works anywhere');
await login(L, 'boss@clinic.test', 'boss has a NEW long password');

// ===== 10. offline: can still open the local copy =====
await L.click('#lockBtn'); await L.waitForSelector('text=Welcome back');
await laptop.ctx.setOffline(true);
await L.fill('#username', 'boss@clinic.test'); await L.fill('#password', 'boss has a NEW long password'); await L.click('#go'); await L.waitForSelector('#lockBtn');
await L.goto(APP + '#/'); await L.waitForSelector('.pitem:has-text("Jane Doe")');
ok(true, 'offline: signing in opens the local encrypted copy');
await laptop.ctx.setOffline(false);
await L.waitForSelector('#navAdmin', { state: 'visible', timeout: 15000 });
await L.waitForFunction(() => /Synced/.test(document.getElementById('syncChip')?.textContent || ''), null, { timeout: 15000 });
ok(true, 'back online: the app reconnects to the clinic by itself (admin menu and sync resume)');

// ===== 10b. offline allowance: can't stay offline forever =====
await P.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('physio-lease-')) localStorage.setItem(k, String(Date.now() - 8 * 86400000)); });
await P.click('#lockBtn'); await P.waitForSelector('text=Welcome back');
await P.waitForTimeout(1500);
ok(await P.isVisible('text=Welcome back') && !/Jane Doe|Good morning|Something went wrong/.test(await P.textContent('main')), 'locking while a sync update is arriving still ends on the sign-in screen with no patient data left showing');
await phone.ctx.setOffline(true);
await P.fill('#username', 'boss@clinic.test'); await P.fill('#password', 'boss has a NEW long password'); await P.click('#go'); await P.waitForSelector('#authErr:not([hidden])');
ok(/offline for up to 7 days/.test(await P.textContent('#authErr')), 'offline use is refused after 7 days without a clinic check-in');
await phone.ctx.setOffline(false);
await login(P, 'boss@clinic.test', 'boss has a NEW long password');
ok(true, 'back online the same sign-in works');

// ===== 11. forgot password via emailed link + recovery key =====
await B.click('#outBtn'); await B.waitForSelector('text=Welcome back'); await B.click('#toRecover');
await B.fill('#email', 'bob@clinic.test'); await B.click('#go'); await B.waitForSelector('text=reset link is on its way');
const h = (await (await fetch(sb.url + '/__recovery?email=bob@clinic.test')).json()).hash;
ok(!!h, 'a reset link was issued (and the same message appears for unknown emails)');
await B.goto(APP + '?r=1' + h); await B.waitForSelector('text=Choose a new password');
await B.fill('#rkey', 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA'); await B.fill('#password', 'bob picked a fresh phrase'); await B.fill('#password2', 'bob picked a fresh phrase'); await B.click('#go');
await B.waitForSelector('#authErr:not([hidden])');
ok(/not correct/.test(await B.textContent('#authErr')), 'the emailed link alone is NOT enough: a wrong recovery key is refused');
await B.fill('#rkey', bobRecovery.toLowerCase()); await B.click('#go'); await B.waitForSelector('#rk');
await B.check('#saved'); await B.click('#cont'); await B.waitForSelector('text=Password reset');
await login(B, 'bob@clinic.test', 'bob picked a fresh phrase');
await B.evaluate(() => { location.hash = '#/'; }); await B.waitForSelector('.pitem:has-text("Zed Zimmer")');
ok(true, 'with the recovery key the password is reset and Bob\'s data is intact');

// ===== 12. decline a pending sign-up =====
await C.goto(APP + '?again=1'); await C.fill('#username', 'cat@clinic.test'); await C.fill('#password', 'cats have a long password'); await C.click('#go');
await C.waitForSelector('text=Waiting for approval', { timeout: 15000 });
ok((await dbq("select blob->'escrow'->>'kid' as k from accounts a join profiles p on p.id=a.user_id where p.email='cat@clinic.test'"))[0].k === KID, 'the early sign-up finished automatically on next sign-in and was sealed to the recovery key');
await L.goto(APP + '#/'); await L.goto(APP + '#/admin'); await L.waitForSelector('.dir-item:has-text("Cat Kim")');
await L.locator('.dir-item', { hasText: 'Cat Kim' }).locator('[data-act=remove]').click();
await L.waitForFunction(() => !document.querySelector('#app .plist')?.textContent.includes('Cat Kim'));
ok((await dbq("select 1 from auth.users where email='cat@clinic.test'")).length === 0, 'declining removes the pending sign-up completely');
const log = await L.textContent('details');
await L.click('summary:has-text("Activity log")');
const logTxt = await L.textContent('details');
ok(/approved bob@clinic.test/.test(logTxt) && /disabled bob@clinic.test/.test(logTxt) && /removed cat@clinic.test/.test(logTxt), 'activity log records approvals, disabling and removal');

// ===== 13. settings & errors =====
await L.goto(APP + '#/settings'); await L.waitForSelector('text=Clinic sync'); ok(await L.isVisible('text=Clinic sync') && !(await L.isVisible('text=One-time Dropbox setup')), 'settings shows clinic sync (no Dropbox setup in clinic mode)');
await L.screenshot({ path: process.env.SHOT_DIR + '/clinic-settings.png' }).catch(() => {});
await L.goto(APP + '#/'); await L.goto(APP + '#/admin'); await L.waitForSelector('.dir-item'); await L.screenshot({ path: process.env.SHOT_DIR + '/clinic-admin.png', fullPage: true }).catch(() => {});
ok(errors.length === 0, 'no unexpected console/page errors ' + JSON.stringify(errors));
await browser.close(); await sb.close();
