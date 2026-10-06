// Per-user, encrypted IndexedDB. Each account has its OWN database (physio-notes-u-<id>); every record is
// AES-GCM encrypted with that account's key before it is written. Only opaque ids are stored in the clear
// (needed for indexes). Nothing is readable without logging in as that user.
import * as C from './crypto.js';
import { dbNameFor } from './auth.js';

const VERSION = 1;
let dbp = null;
let key = null;
let dbName = null;

export function openUser(userId, sessionKey) {
  lock();
  key = sessionKey;
  dbName = dbNameFor(userId);
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('patients', { keyPath: 'id' });
      db.createObjectStore('visits', { keyPath: 'id' }).createIndex('patientId', 'patientId');
      db.createObjectStore('audio', { keyPath: 'id' }).createIndex('visitId', 'visitId');
      db.createObjectStore('settings', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

export function lock() {
  dbp?.then((d) => d.close()).catch(() => {});
  dbp = null;
  key = null;
  dbName = null;
}
export const isOpen = () => !!key;

export function destroyUserDb(userId) {
  return new Promise((res) => {
    const r = indexedDB.deleteDatabase(dbNameFor(userId));
    r.onsuccess = r.onerror = r.onblocked = () => res();
  });
}

const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
async function store(name, mode = 'readonly') {
  if (!dbp) throw new Error('Locked — please sign in.');
  return (await dbp).transaction(name, mode).objectStore(name);
}
const aad = (name, id) => `${name}:${id}`;

async function seal(name, obj) {
  if (!key) throw new Error('Locked — please sign in.');
  if (name === 'audio') {
    const { blob, ...meta } = obj;
    const bl = await C.encryptBytes(key, await blob.arrayBuffer(), aad('audio-blob', obj.id));
    const m = await C.encryptJson(key, meta, aad(name, obj.id));
    return { id: obj.id, visitId: obj.visitId, iv: m.iv, ct: m.ct, bl, mime: blob.type };
  }
  const box = await C.encryptJson(key, obj, aad(name, obj.id));
  const row = { id: obj.id, iv: box.iv, ct: box.ct };
  if (name === 'visits') row.patientId = obj.patientId;
  return row;
}
async function open(name, row) {
  if (!row) return row;
  const obj = await C.decryptJson(key, row, aad(name, row.id));
  if (name === 'audio') obj.blob = new Blob([await C.decryptBytes(key, row.bl, aad('audio-blob', row.id))], { type: row.mime });
  return obj;
}
const openAll = (name, rows) => Promise.all(rows.map((r) => open(name, r)));

export const getAll = async (name) => openAll(name, await wrap((await store(name)).getAll()));
export const get = async (name, id) => open(name, await wrap((await store(name)).get(id)));
export const put = async (name, obj) => { const row = await seal(name, obj); return wrap((await store(name, 'readwrite')).put(row)); };
export const del = async (name, id) => wrap((await store(name, 'readwrite')).delete(id));
export const byIndex = async (name, index, value) => openAll(name, await wrap((await store(name)).index(index).getAll(value)));
export const countBy = async (name, index, value) => wrap((await store(name)).index(index).count(value));

export async function deletePatient(id) {
  for (const v of await byIndex('visits', 'patientId', id)) await deleteVisit(v.id);
  await del('patients', id);
}
export async function deleteVisit(id) {
  const s = await store('audio');
  for (const k of await wrap(s.index('visitId').getAllKeys(id))) await del('audio', k);
  await del('visits', id);
}
// Removes all patient data but keeps settings and the account.
export async function clearPatientData() {
  for (const n of ['patients', 'visits', 'audio']) await wrap((await store(n, 'readwrite')).clear());
}

// ---- legacy (pre-accounts) plaintext database, so earlier notes can be claimed into an account ----
export async function legacyExists() {
  try {
    if (!indexedDB.databases) return false;
    return (await indexedDB.databases()).some((d) => d.name === 'physio-notes');
  } catch { return false; }
}
export function readLegacy() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('physio-notes');
    req.onerror = () => reject(req.error);
    req.onsuccess = async () => {
      const db = req.result;
      try {
        const all = (n) => (db.objectStoreNames.contains(n) ? wrap(db.transaction(n).objectStore(n).getAll()) : []);
        resolve({ patients: await all('patients'), visits: await all('visits'), audio: await all('audio') });
      } catch (e) { reject(e); } finally { db.close(); }
    };
  });
}
export const deleteLegacy = () => new Promise((res) => { const r = indexedDB.deleteDatabase('physio-notes'); r.onsuccess = r.onerror = r.onblocked = () => res(); });
