// IndexedDB wrapper. Everything lives on this device; nothing is uploaded.
const DB_NAME = 'physio-notes';
const VERSION = 1;
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('patients', { keyPath: 'id' });
      db.createObjectStore('visits', { keyPath: 'id' }).createIndex('patientId', 'patientId');
      db.createObjectStore('audio', { keyPath: 'id' }).createIndex('visitId', 'visitId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export const getAll = async (name) => wrap((await store(name)).getAll());
export const get = async (name, id) => wrap((await store(name)).get(id));
export const put = async (name, obj) => wrap((await store(name, 'readwrite')).put(obj));
export const del = async (name, id) => wrap((await store(name, 'readwrite')).delete(id));
export const byIndex = async (name, index, value) => wrap((await store(name)).index(index).getAll(value));

export async function deletePatient(id) {
  for (const v of await byIndex('visits', 'patientId', id)) await deleteVisit(v.id);
  await del('patients', id);
}
export async function deleteVisit(id) {
  for (const a of await byIndex('audio', 'visitId', id)) await del('audio', a.id);
  await del('visits', id);
}
export async function clearAll() {
  for (const n of ['patients', 'visits', 'audio']) await wrap((await store(n, 'readwrite')).clear());
}
export const countBy = async (name, index, value) => wrap((await store(name)).index(index).count(value));
