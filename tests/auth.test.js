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
