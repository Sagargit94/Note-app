// Web Crypto helpers. Key hierarchy:
//   password --PBKDF2(600k)--> KEK(pw) --wraps--> DEK (random AES-256 data key)
//   recovery key --PBKDF2--> KEK(rec) --wraps--> the same DEK
// Every stored record is AES-256-GCM encrypted with the DEK (non-extractable once loaded) and bound to its
// own store+id via AAD, so ciphertext cannot be swapped between records. Wrong password => unwrap fails.
const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

export const PBKDF2_ITER = 600000;
const REC_ITER = 100000;

export const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

export function b64e(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64d(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function kekFrom(secret, salt, iterations) {
  const base = await subtle.importKey('raw', te.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
}
export const passwordKek = (password, salt, iterations = PBKDF2_ITER) => kekFrom(password.normalize('NFKC'), salt, iterations);
export const recoveryKek = (recoveryKey, salt) => kekFrom(normalizeRecovery(recoveryKey), salt, REC_ITER);

export const newDataKey = () => subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);

export async function wrapDek(dek, kek) {
  const iv = randomBytes(12);
  const w = await subtle.wrapKey('raw', dek, kek, { name: 'AES-GCM', iv });
  return { iv: b64e(iv), w: b64e(w) };
}
// Returns a NON-extractable key by default (extractable only briefly, to re-wrap on password change). Throws if the KEK is wrong.
export const unwrapDek = (wrapped, kek, extractable = false) =>
  subtle.unwrapKey('raw', b64d(wrapped.w), kek, { name: 'AES-GCM', iv: b64d(wrapped.iv) }, { name: 'AES-GCM' }, extractable, ['encrypt', 'decrypt']);

// --- recovery key: 160 random bits as 8 groups of 4 base32 chars ---
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newRecoveryKey() {
  const bytes = randomBytes(20);
  let bits = 0, val = 0, out = '';
  for (const byte of bytes) {
    val = (val << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += ALPHA[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return out.match(/.{4}/g).join('-');
}
export const normalizeRecovery = (s) => String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');

// --- record encryption ---
export async function encryptBytes(key, bytes, aad) {
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, bytes);
  return { iv, ct };
}
export const decryptBytes = (key, { iv, ct }, aad) => subtle.decrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, ct);
export const encryptJson = (key, obj, aad) => encryptBytes(key, te.encode(JSON.stringify(obj)), aad);
export async function decryptJson(key, box, aad) {
  return JSON.parse(td.decode(await decryptBytes(key, box, aad)));
}

// --- passphrase-encrypted backup files ---
export async function encryptWithPassphrase(passphrase, text) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const kek = await subtle.importKey('raw', te.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' }, kek, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(text));
  return { app: 'physio-notes', encrypted: true, v: 1, iter: PBKDF2_ITER, salt: b64e(salt), iv: b64e(iv), data: b64e(ct) };
}
export async function decryptWithPassphrase(passphrase, file) {
  const kek = await subtle.importKey('raw', te.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'PBKDF2', salt: b64d(file.salt), iterations: file.iter || PBKDF2_ITER, hash: 'SHA-256' }, kek, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  try {
    return td.decode(await subtle.decrypt({ name: 'AES-GCM', iv: b64d(file.iv) }, key, b64d(file.data)));
  } catch { throw new Error('Wrong passphrase or damaged backup file.'); }
}
