import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// minimal localStorage for Node
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const Auth = await import('../js/auth.js');
const C = await import('../js/crypto.js');
beforeEach(() => mem.clear());

const PW = 'correct horse battery';

test('sign up, log in, wrong password and unknown user are rejected identically', async () => {
  await Auth.signUp({ username: 'Alice', displayName: 'Alice P', password: PW });
  const ok = await Auth.logIn('alice', PW);
  assert.equal(ok.user.displayName, 'Alice P');
  await assert.rejects(Auth.logIn('alice', 'wrong password!!'), /Incorrect username or password/);
  await assert.rejects(Auth.logIn('nobody', PW), /Incorrect username or password/);
});

test('duplicate usernames and weak passwords rejected', async () => {
  await Auth.signUp({ username: 'bob', password: PW });
  await assert.rejects(Auth.signUp({ username: 'BOB', password: PW }), /already taken/);
  await assert.rejects(Auth.signUp({ username: 'carol', password: 'short' }), /at least/);
  await assert.rejects(Auth.signUp({ username: 'c', password: PW }), /Username/);
});

test('registry contains no plaintext password or raw data key', async () => {
  await Auth.signUp({ username: 'dave', password: PW });
  assert.ok(!mem.get('physio-accounts-v1').includes(PW));
});

test('two users have independent keys; one cannot decrypt the other\'s data', async () => {
  const a = await Auth.signUp({ username: 'user1', password: PW });
  const b = await Auth.signUp({ username: 'user2', password: PW + ' two' });
  const box = await C.encryptJson(a.key, { name: 'Jane Doe' }, 'patients:1');
  assert.deepEqual(await C.decryptJson(a.key, box, 'patients:1'), { name: 'Jane Doe' });
  await assert.rejects(C.decryptJson(b.key, box, 'patients:1'));
});

test('ciphertext is bound to its record id (AAD) and tamper-evident', async () => {
  const a = await Auth.signUp({ username: 'eve', password: PW });
  const box = await C.encryptJson(a.key, { x: 1 }, 'patients:A');
  await assert.rejects(C.decryptJson(a.key, box, 'patients:B'));
  const bad = { iv: box.iv, ct: new Uint8Array(box.ct).map((v, i) => (i === 3 ? v ^ 1 : v)).buffer };
  await assert.rejects(C.decryptJson(a.key, bad, 'patients:A'));
});

test('change password keeps data readable; old password stops working', async () => {
  const s = await Auth.signUp({ username: 'fay', password: PW });
  const box = await C.encryptJson(s.key, { note: 'secret' }, 'visits:1');
  await assert.rejects(Auth.changePassword('fay', 'bad bad bad bad', 'brand new password'), /incorrect/);
  await Auth.changePassword('fay', PW, 'brand new password');
  await assert.rejects(Auth.logIn('fay', PW));
  const again = await Auth.logIn('fay', 'brand new password');
  assert.deepEqual(await C.decryptJson(again.key, box, 'visits:1'), { note: 'secret' });
});

test('recovery key resets password, data survives, old recovery key is retired', async () => {
  const s = await Auth.signUp({ username: 'gus', password: PW });
  const box = await C.encryptJson(s.key, { note: 'keep me' }, 'visits:2');
  await assert.rejects(Auth.resetWithRecovery('gus', 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA', 'another long password'), /not correct/);
  const r = await Auth.resetWithRecovery('gus', s.recoveryKey.toLowerCase().replace(/-/g, ' '), 'another long password');
  const again = await Auth.logIn('gus', 'another long password');
  assert.deepEqual(await C.decryptJson(again.key, box, 'visits:2'), { note: 'keep me' });
  assert.notEqual(r.recoveryKey, s.recoveryKey);
  await assert.rejects(Auth.resetWithRecovery('gus', s.recoveryKey, 'yet another password'), /not correct/);
});

test('session key is not extractable', async () => {
  const s = await Auth.signUp({ username: 'hal', password: PW });
  assert.equal(s.key.extractable, false);
});

test('passphrase-encrypted backups round trip and reject wrong passphrase', async () => {
  const f = await C.encryptWithPassphrase('backup pass phrase', '{"patients":[{"n":"Jane"}]}');
  assert.ok(!JSON.stringify(f).includes('Jane'));
  assert.equal(await C.decryptWithPassphrase('backup pass phrase', f), '{"patients":[{"n":"Jane"}]}');
  await assert.rejects(C.decryptWithPassphrase('nope nope nope', f), /Wrong passphrase/);
});

test('removing an account needs the password', async () => {
  await Auth.signUp({ username: 'ian', password: PW });
  await assert.rejects(Auth.removeAccount('ian', 'wrong wrong wrong'), /incorrect/);
  await Auth.removeAccount('ian', PW);
  assert.equal(Auth.listAccounts().length, 0);
});

test('account can be exported and imported on another device (same data key)', async () => {
  const s = await Auth.signUp({ username: 'joan', displayName: 'Jo', password: PW });
  const box = await C.encryptJson(s.key, { x: 'secret' }, 'patients:z');
  const blob = JSON.parse(JSON.stringify(Auth.publicAccount('joan')));
  mem.clear(); // "new device"
  Auth.importAccount(blob);
  const again = await Auth.logIn('joan', PW);
  assert.deepEqual(await C.decryptJson(again.key, box, 'patients:z'), { x: 'secret' });
  assert.ok(!JSON.stringify(blob).includes(PW));
  assert.throws(() => Auth.importAccount({ id: 'x', username: 'joan' }), /damaged/);
});

test('wire format round-trips ciphertext rows', async () => {
  const s = await Auth.signUp({ username: 'kim', password: PW });
  const box = await C.encryptJson(s.key, { a: 1 }, 'visits:1');
  const row = C.wireToRow(JSON.parse(JSON.stringify(C.rowToWire({ id: '1', ...box }))));
  assert.deepEqual(await C.decryptJson(s.key, row, 'visits:1'), { a: 1 });
});

test('deriveKeys: KEK matches the legacy derivation (existing accounts keep working) and gives a separate login secret', async () => {
  const salt = C.randomBytes(16);
  const dek = await C.newDataKey();
  const wrapped = await C.wrapDek(dek, await C.passwordKek('legacy password!!', salt));          // made by an older version
  const { kek, authSecret } = await C.deriveKeys('legacy password!!', salt);
  const key = await C.unwrapDek(wrapped, kek);                                                    // opened by the new derivation
  const box = await C.encryptJson(key, { ok: 1 }, 'x:1');
  assert.deepEqual(await C.decryptJson(await C.unwrapDek(wrapped, await C.passwordKek('legacy password!!', salt)), box, 'x:1'), { ok: 1 });
  assert.match(authSecret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await C.deriveKeys('legacy password!!', salt)).authSecret, authSecret);          // deterministic
  assert.notEqual((await C.deriveKeys('legacy password!?', salt)).authSecret, authSecret);
  assert.notEqual((await C.deriveKeys('legacy password!!', C.randomBytes(16))).authSecret, authSecret);
});

test('clinic accounts use an email as username; sign-up/login/new-device all yield the same login secret', async () => {
  const s = await Auth.signUp({ username: 'Dana@Clinic.test', displayName: 'Dana', password: PW, central: true });
  assert.equal(s.user.username, 'dana@clinic.test'); assert.equal(s.user.central, true);
  assert.equal((await Auth.logIn('DANA@clinic.test', PW)).authSecret, s.authSecret);
  const blob = Auth.publicAccount('dana@clinic.test');
  assert.equal(await Auth.deriveAuthSecret(PW, blob.kdf), s.authSecret);                         // what a brand-new device computes
  await assert.rejects(Auth.signUp({ username: 'not an email', password: PW, central: true }), /valid email/);
});

test('commit hook: if the server update fails, the local password is NOT changed', async () => {
  await Auth.signUp({ username: 'erin@clinic.test', password: PW, central: true });
  await assert.rejects(Auth.changePassword('erin@clinic.test', PW, 'a different long password', { commit: async () => { throw new Error('server down'); } }), /server down/);
  assert.ok(await Auth.logIn('erin@clinic.test', PW));                                            // old password still works
  let seen;
  const r = await Auth.changePassword('erin@clinic.test', PW, 'a different long password', { commit: async (x) => { seen = x; } });
  assert.equal(seen.authSecret, r.authSecret); assert.ok(seen.account.pw.w);
  assert.equal((await Auth.logIn('erin@clinic.test', 'a different long password')).authSecret, r.authSecret);
  await assert.rejects(Auth.logIn('erin@clinic.test', PW));
});

test('forgetAccount removes a half-created account', async () => {
  const s = await Auth.signUp({ username: 'fred@clinic.test', password: PW, central: true });
  Auth.forgetAccount(s.user.id);
  assert.equal(Auth.listAccounts().length, 0);
});

// ---- clinic recovery + local lock-out ----
const R = await import('../js/recovery.js');

test('clinic recovery: a sealed account can be opened ONLY with the clinic recovery key', async () => {
  const kp = await C.generateClinicKeyPair();
  assert.match(kp.kid, /^[0-9a-f]{16}$/); assert.equal(kp.publicJwk.d, undefined);
  const s = await Auth.signUp({ username: 'gwen@clinic.test', displayName: 'Gwen', password: PW, central: true, escrow: { jwk: kp.publicJwk, kid: kp.kid } });
  const blob = Auth.publicAccount('gwen@clinic.test');
  assert.equal(blob.escrow.kid, kp.kid);
  assert.ok(!JSON.stringify(blob).includes(PW));
  // records exactly as the app's database seals them
  const aad = (n, id) => `${n}:${id}`;
  const pat = await C.encryptJson(s.key, { id: 'p1', firstName: 'Zed', lastName: 'Zimmer' }, aad('patients', 'p1'));
  const vis = await C.encryptJson(s.key, { id: 'v1', patientId: 'p1', subjective: 'RECOVER-ME' }, aad('visits', 'v1'));
  const meta = await C.encryptJson(s.key, { id: 'a1', visitId: 'v1', durationSec: 3 }, aad('audio', 'a1'));
  const bl = await C.encryptBytes(s.key, new Uint8Array([1, 2, 3, 4]).buffer, aad('audio-blob', 'a1'));
  const wire = (id, box, extra = {}) => JSON.stringify({ v: 1, row: C.rowToWire({ id, iv: box.iv, ct: box.ct, ...extra }) });
  const items = [
    { k: 'p', id: 'p1', body: wire('p1', pat) }, { k: 'v', id: 'v1', body: wire('v1', vis) },
    { k: 'a', id: 'a1', body: wire('a1', meta, { bl, mime: 'audio/webm' }) },
    { k: 's', id: 'main', body: wire('main', pat) },                      // settings are never recovered
    { k: 'p', id: 'bad', body: '{"row":"garbage"}' },                     // corrupt record is skipped, not fatal
  ];
  const out = await R.openRecovered({ escrow: blob.escrow, privateJwk: kp.privateJwk, items });
  assert.equal(out.patients[0].firstName, 'Zed'); assert.equal(out.visits[0].subjective, 'RECOVER-ME');
  assert.equal(out.audio.length, 1); assert.deepEqual([...C.b64d(out.audio[0].data)], [1, 2, 3, 4]); assert.equal(out.audio[0].mime, 'audio/webm');
  assert.equal(out.skipped, 1);
  assert.equal(R.toBackup(out).app, 'physio-notes');
  // a different clinic key cannot open it
  const other = await C.generateClinicKeyPair();
  await assert.rejects(R.openRecovered({ escrow: blob.escrow, privateJwk: other.privateJwk, items }));
});

test('addEscrow seals an existing account to a (new) clinic key; wrong password refused; server failure changes nothing', async () => {
  const kp = await C.generateClinicKeyPair();
  await Auth.signUp({ username: 'hugo@clinic.test', password: PW, central: true });                  // made before recovery existed
  assert.equal(Auth.publicAccount('hugo@clinic.test').escrow, undefined);
  await assert.rejects(Auth.addEscrow('hugo@clinic.test', 'wrong wrong wrong', { jwk: kp.publicJwk, kid: kp.kid }), /incorrect/);
  await assert.rejects(Auth.addEscrow('hugo@clinic.test', PW, { jwk: kp.publicJwk, kid: kp.kid }, { commit: async () => { throw new Error('offline'); } }), /offline/);
  assert.equal(Auth.publicAccount('hugo@clinic.test').escrow, undefined);
  await Auth.addEscrow('hugo@clinic.test', PW, { jwk: kp.publicJwk, kid: kp.kid });
  assert.equal(Auth.publicAccount('hugo@clinic.test').escrow.kid, kp.kid);
  const kp2 = await C.generateClinicKeyPair();                                                           // key rotation: re-seal to the new key
  await Auth.addEscrow('hugo@clinic.test', PW, { jwk: kp2.publicJwk, kid: kp2.kid });
  assert.equal(Auth.publicAccount('hugo@clinic.test').escrow.kid, kp2.kid);
  assert.ok(await Auth.logIn('hugo@clinic.test', PW));                                                   // unaffected for the user
});

test('disabled: revokeLocal makes local data unopenable even with the right password; re-importing the clinic file restores it', async () => {
  const s = await Auth.signUp({ username: 'ivy@clinic.test', displayName: 'Ivy', password: PW, central: true });
  const box = await C.encryptJson(s.key, { note: 'stays on the device' }, 'visits:7');
  const serverCopy = JSON.parse(JSON.stringify(Auth.publicAccount('ivy@clinic.test')));               // what the clinic holds
  Auth.revokeLocal(s.user.id);
  assert.equal(Auth.isRevoked('ivy@clinic.test'), true);
  const entry = Auth.listAccounts().find((x) => x.username === 'ivy@clinic.test');
  assert.equal(entry.pw, undefined); assert.equal(entry.rec, undefined);                               // nothing left to unlock with
  assert.ok(!JSON.stringify(Auth.listAccounts()).includes(serverCopy.pw.w));
  await assert.rejects(Auth.logIn('ivy@clinic.test', PW), (e) => e.code === 'revoked' && /disabled/.test(e.message));
  await assert.rejects(Auth.resetWithRecovery('ivy@clinic.test', s.recoveryKey, 'another long password'), /not correct/);   // recovery key can't bypass it locally either
  Auth.importAccount(serverCopy);                                                                        // re-enabled: sign-in fetched the key file again
  const back = await Auth.logIn('ivy@clinic.test', PW);
  assert.deepEqual(await C.decryptJson(back.key, box, 'visits:7'), { note: 'stays on the device' });
});
