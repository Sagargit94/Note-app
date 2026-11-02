// Local accounts. The registry holds only public material (salts + wrapped keys); patient data never touches it.
import * as C from './crypto.js';
import { uid } from './util.js';

const REG = 'physio-accounts-v1';
export const MIN_PASSWORD = 10;

function store() { return globalThis.localStorage; }
export function listAccounts() {
  try { return JSON.parse(store().getItem(REG) || '[]'); } catch { return []; }
}
function saveAccounts(a) { store().setItem(REG, JSON.stringify(a)); }
const norm = (u) => String(u || '').trim().toLowerCase();
// Solo mode: short handle. Clinic mode: the person's email address.
export const validUsername = (u) => /^[a-z0-9._-]{3,32}$/.test(u) || (u.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u));
export const dbNameFor = (id) => 'physio-notes-u-' + id;

export function validatePassword(pw) {
  if (!pw || pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters (a short sentence is ideal).`;
  if (/^(.)\1+$/.test(pw) || /^(password|1234567890|qwertyuiop)/i.test(pw)) return 'That password is too easy to guess.';
  return '';
}

// -> { user, key, recoveryKey }
export async function signUp({ username, displayName, password, central = false, escrow = null }) {
  const u = norm(username);
  if (!validUsername(u)) throw new Error(central ? 'Enter a valid email address.' : 'Username: 3–32 letters, numbers, dot, dash or underscore.');
  const bad = validatePassword(password);
  if (bad) throw new Error(bad);
  const accounts = listAccounts();
  if (accounts.some((a) => a.username === u)) throw new Error('That username is already taken on this device.');

  const dek = await C.newDataKey();
  const salt = C.randomBytes(16), recSalt = C.randomBytes(16);
  const recoveryKey = C.newRecoveryKey();
  const { kek, authSecret } = await C.deriveKeys(password, salt);
  const user = {
    id: uid(), username: u, displayName: String(displayName || '').trim() || u, createdAt: new Date().toISOString(), central: !!central,
    kdf: { salt: C.b64e(salt), iter: C.PBKDF2_ITER },
    pw: await C.wrapDek(dek, kek),
    ...(escrow ? { escrow: await C.wrapForClinic(dek, escrow.jwk, escrow.kid) } : {}), // clinic recovery seal (clinic mode)
    rec: { salt: C.b64e(recSalt), ...(await C.wrapDek(dek, await C.recoveryKek(recoveryKey, recSalt))) },
  };
  accounts.push(user);
  saveAccounts(accounts);
  const key = await C.unwrapDek(user.pw, kek); // non-extractable session key
  return { user: pub(user), key, recoveryKey, authSecret };
}

const pub = (a) => ({ id: a.id, username: a.username, displayName: a.displayName, central: !!a.central });

export async function logIn(username, password) {
  const a = listAccounts().find((x) => x.username === norm(username));
  const fail = () => new Error('Incorrect username or password.');
  if (!a) { await C.passwordKek(password || 'x', C.randomBytes(16)); throw fail(); } // similar timing either way
  if (a.revoked) { const e = new Error('Your access to the clinic has been disabled. Connect to the internet and sign in again once an administrator has re-enabled you.'); e.code = 'revoked'; throw e; }
  try {
    const { kek, authSecret } = await C.deriveKeys(password, C.b64d(a.kdf.salt), a.kdf.iter);
    return { user: pub(a), key: await C.unwrapDek(a.pw, kek), authSecret };
  } catch { throw fail(); }
}

async function setPassword(a, dek, newPassword) {
  const salt = C.randomBytes(16);
  const { kek, authSecret } = await C.deriveKeys(newPassword, salt);
  a.kdf = { salt: C.b64e(salt), iter: C.PBKDF2_ITER };
  a.pw = await C.wrapDek(dek, kek);
  return authSecret;
}
async function setRecovery(a, dek) {
  const recoveryKey = C.newRecoveryKey();
  const salt = C.randomBytes(16);
  a.rec = { salt: C.b64e(salt), ...(await C.wrapDek(dek, await C.recoveryKek(recoveryKey, salt))) };
  return recoveryKey;
}
function find(accounts, username) {
  const a = accounts.find((x) => x.username === norm(username));
  if (!a) throw new Error('Account not found.');
  return a;
}
// Persists a modified copy. `commit` (optional) runs first -- e.g. to update the clinic server -- and if it throws,
// nothing is changed locally, so the two sides can't end up with different passwords.
async function persist(accounts, original, modified, commit, extra) {
  if (commit) await commit({ account: { ...modified }, ...extra });
  accounts[accounts.indexOf(original)] = modified;
  saveAccounts(accounts);
}

// Forgot password: prove possession of the recovery key, then set a new password AND a fresh recovery key.
export async function resetWithRecovery(username, recoveryKey, newPassword, { commit } = {}) {
  const bad = validatePassword(newPassword);
  if (bad) throw new Error(bad);
  const accounts = listAccounts();
  const a = accounts.find((x) => x.username === norm(username));
  if (!a) throw new Error('Username or recovery key is not correct.');
  let dek;
  try { dek = await C.unwrapDek(a.rec, await C.recoveryKek(recoveryKey, C.b64d(a.rec.salt)), true); } catch { throw new Error('Username or recovery key is not correct.'); }
  const m = { ...a };
  const authSecret = await setPassword(m, dek, newPassword);
  const newRecovery = await setRecovery(m, dek);
  await persist(accounts, a, m, commit, { authSecret });
  return { recoveryKey: newRecovery, authSecret };
}

export async function changePassword(username, oldPassword, newPassword, { commit } = {}) {
  const bad = validatePassword(newPassword);
  if (bad) throw new Error(bad);
  const accounts = listAccounts();
  const a = find(accounts, username);
  let dek;
  try { dek = await C.unwrapDek(a.pw, (await C.deriveKeys(oldPassword, C.b64d(a.kdf.salt), a.kdf.iter)).kek, true); } catch { throw new Error('Current password is incorrect.'); }
  const m = { ...a };
  const authSecret = await setPassword(m, dek, newPassword);
  await persist(accounts, a, m, commit, { authSecret });
  return { authSecret };
}

export async function newRecoveryKey(username, password, { commit } = {}) {
  const accounts = listAccounts();
  const a = find(accounts, username);
  let dek;
  try { dek = await C.unwrapDek(a.pw, (await C.deriveKeys(password, C.b64d(a.kdf.salt), a.kdf.iter)).kek, true); } catch { throw new Error('Password is incorrect.'); }
  const m = { ...a };
  const k = await setRecovery(m, dek);
  await persist(accounts, a, m, commit, {});
  return k;
}

// Verifies the password, removes the account from the registry. Caller deletes the encrypted database.
export async function removeAccount(username, password, { beforeRemove } = {}) {
  const accounts = listAccounts();
  const a = find(accounts, username);
  try { await C.unwrapDek(a.pw, (await C.deriveKeys(password, C.b64d(a.kdf.salt), a.kdf.iter)).kek); } catch { throw new Error('Password is incorrect.'); }
  await beforeRemove?.(); // e.g. delete the clinic-side copy first; if that fails the local account is kept
  saveAccounts(accounts.filter((x) => x !== a));
  return a.id;
}

// Removes a half-created account (e.g. clinic sign-up failed) without needing the password.
export function forgetAccount(id) { saveAccounts(listAccounts().filter((x) => x.id !== id)); }

// The login secret for given hashing parameters (new-device sign-in, before the account exists locally).
export async function deriveAuthSecret(password, kdf) {
  return (await C.deriveKeys(password, C.b64d(kdf.salt), kdf.iter)).authSecret;
}

// The registry entry holds only public material (salts + wrapped keys), so it is what gets synced to new devices.
export function publicAccount(username) { return { ...find(listAccounts(), username) }; }

// Adds (or refreshes, e.g. after a password change on another device) an account fetched from the user's cloud folder.
export function importAccount(blob) {
  const ok = blob && typeof blob.id === 'string' && validUsername(blob.username || '') && blob.kdf?.salt && blob.pw?.w && blob.rec?.w;
  if (!ok) throw new Error('That account file is damaged.');
  const accounts = listAccounts();
  if (accounts.some((x) => x.username === blob.username && x.id !== blob.id)) throw new Error(`A different account called @${blob.username} already exists on this device.`);
  const entry = { id: blob.id, username: blob.username, displayName: blob.displayName || blob.username, createdAt: blob.createdAt, central: !!blob.central, kdf: blob.kdf, pw: blob.pw, rec: blob.rec, ...(blob.escrow ? { escrow: blob.escrow } : {}) };
  const i = accounts.findIndex((x) => x.id === blob.id);
  if (i >= 0) accounts[i] = entry; else accounts.push(entry);
  saveAccounts(accounts);
  return pub(entry);
}

// ---- clinic: local lock-out and recovery sealing ----------------------------------------------------------------
// When the clinic disables someone, this device forgets the wrapped keys that a password could unlock. The encrypted
// data stays on the device but is unreadable until an administrator re-enables the account and the person signs in
// online (which fetches the key file from the clinic again).
export function revokeLocal(id) {
  const accounts = listAccounts();
  const i = accounts.findIndex((x) => x.id === id);
  if (i < 0) return;
  const { pw, rec, ...rest } = accounts[i]; // eslint-disable-line no-unused-vars
  accounts[i] = { ...rest, revoked: true };
  saveAccounts(accounts);
}
export const isRevoked = (username) => !!listAccounts().find((x) => x.username === norm(username))?.revoked;

export async function verifyPassword(username, password) {
  const a = find(listAccounts(), username);
  try { await C.unwrapDek(a.pw, (await C.deriveKeys(password, C.b64d(a.kdf.salt), a.kdf.iter)).kek); } catch { throw new Error('Password is incorrect.'); }
}

// Seals (or re-seals, after the clinic key changed) this account's data key to the clinic recovery key.
export async function addEscrow(username, password, { jwk, kid }, { commit } = {}) {
  const accounts = listAccounts();
  const a = find(accounts, username);
  let dek;
  try { dek = await C.unwrapDek(a.pw, (await C.deriveKeys(password, C.b64d(a.kdf.salt), a.kdf.iter)).kek, true); } catch { throw new Error('Password is incorrect.'); }
  const m = { ...a, escrow: await C.wrapForClinic(dek, jwk, kid) };
  await persist(accounts, a, m, commit, {});
}
