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
export const dbNameFor = (id) => 'physio-notes-u-' + id;

export function validatePassword(pw) {
  if (!pw || pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters (a short sentence is ideal).`;
  if (/^(.)\1+$/.test(pw) || /^(password|1234567890|qwertyuiop)/i.test(pw)) return 'That password is too easy to guess.';
  return '';
}

// -> { user, key, recoveryKey }
export async function signUp({ username, displayName, password }) {
  const u = norm(username);
  if (!/^[a-z0-9._-]{3,32}$/.test(u)) throw new Error('Username: 3–32 letters, numbers, dot, dash or underscore.');
  const bad = validatePassword(password);
  if (bad) throw new Error(bad);
  const accounts = listAccounts();
  if (accounts.some((a) => a.username === u)) throw new Error('That username is already taken on this device.');

  const dek = await C.newDataKey();
  const salt = C.randomBytes(16), recSalt = C.randomBytes(16);
  const recoveryKey = C.newRecoveryKey();
  const user = {
    id: uid(), username: u, displayName: String(displayName || '').trim() || u, createdAt: new Date().toISOString(),
    kdf: { salt: C.b64e(salt), iter: C.PBKDF2_ITER },
    pw: await C.wrapDek(dek, await C.passwordKek(password, salt)),
    rec: { salt: C.b64e(recSalt), ...(await C.wrapDek(dek, await C.recoveryKek(recoveryKey, recSalt))) },
  };
  accounts.push(user);
  saveAccounts(accounts);
  const key = await C.unwrapDek(user.pw, await C.passwordKek(password, salt)); // non-extractable session key
  return { user: pub(user), key, recoveryKey };
}

const pub = (a) => ({ id: a.id, username: a.username, displayName: a.displayName });

export async function logIn(username, password) {
  const a = listAccounts().find((x) => x.username === norm(username));
  const fail = () => new Error('Incorrect username or password.');
  if (!a) { await C.passwordKek(password || 'x', C.randomBytes(16)); throw fail(); } // similar timing either way
  try {
    const key = await C.unwrapDek(a.pw, await C.passwordKek(password, C.b64d(a.kdf.salt), a.kdf.iter));
    return { user: pub(a), key };
  } catch { throw fail(); }
}

async function setPassword(a, dek, newPassword) {
  const salt = C.randomBytes(16);
  a.kdf = { salt: C.b64e(salt), iter: C.PBKDF2_ITER };
  a.pw = await C.wrapDek(dek, await C.passwordKek(newPassword, salt));
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

// Forgot password: prove possession of the recovery key, then set a new password AND a fresh recovery key.
export async function resetWithRecovery(username, recoveryKey, newPassword) {
  const bad = validatePassword(newPassword);
  if (bad) throw new Error(bad);
  const accounts = listAccounts();
  const a = accounts.find((x) => x.username === norm(username));
  if (!a) throw new Error('Username or recovery key is not correct.');
  let dek;
  try { dek = await C.unwrapDek(a.rec, await C.recoveryKek(recoveryKey, C.b64d(a.rec.salt)), true); } catch { throw new Error('Username or recovery key is not correct.'); }
  await setPassword(a, dek, newPassword);
  const newRecovery = await setRecovery(a, dek);
  saveAccounts(accounts);
  return { recoveryKey: newRecovery };
}

export async function changePassword(username, oldPassword, newPassword) {
  const bad = validatePassword(newPassword);
  if (bad) throw new Error(bad);
  const accounts = listAccounts();
  const a = find(accounts, username);
  let dek;
  try { dek = await C.unwrapDek(a.pw, await C.passwordKek(oldPassword, C.b64d(a.kdf.salt), a.kdf.iter), true); } catch { throw new Error('Current password is incorrect.'); }
  await setPassword(a, dek, newPassword);
  saveAccounts(accounts);
}

export async function newRecoveryKey(username, password) {
  const accounts = listAccounts();
  const a = find(accounts, username);
  let dek;
  try { dek = await C.unwrapDek(a.pw, await C.passwordKek(password, C.b64d(a.kdf.salt), a.kdf.iter), true); } catch { throw new Error('Password is incorrect.'); }
  const k = await setRecovery(a, dek);
  saveAccounts(accounts);
  return k;
}

// Verifies the password, removes the account from the registry. Caller deletes the encrypted database.
export async function removeAccount(username, password) {
  const accounts = listAccounts();
  const a = find(accounts, username);
  try { await C.unwrapDek(a.pw, await C.passwordKek(password, C.b64d(a.kdf.salt), a.kdf.iter)); } catch { throw new Error('Password is incorrect.'); }
  saveAccounts(accounts.filter((x) => x !== a));
  return a.id;
}
