// Clinic recovery: decrypts a departed clinician's records using the clinic recovery key (admin's browser only).
import * as C from './crypto.js';

const NAME = { p: 'patients', v: 'visits', a: 'audio' };

// items: [{k, id, body}] as returned by the server's admin_user_records. Settings (which hold personal API keys) are
// deliberately NOT recovered. Returns objects in the same shape the app's backups use.
export async function openRecovered({ escrow, privateJwk, items }) {
  const key = await C.unwrapFromClinic(escrow, privateJwk); // throws if this is not the right recovery key
  const out = { patients: [], visits: [], audio: [], skipped: 0 };
  for (const it of items) {
    const name = NAME[it.k];
    if (!name) continue;
    try {
      const row = C.wireToRow(JSON.parse(it.body).row);
      const obj = await C.decryptJson(key, row, `${name}:${row.id}`);
      if (name === 'audio') out.audio.push({ ...obj, mime: row.mime, data: C.b64e(await C.decryptBytes(key, row.bl, `audio-blob:${row.id}`)) });
      else out[name].push(obj);
    } catch { out.skipped++; }
  }
  return out;
}
export const toBackup = (r) => ({ app: 'physio-notes', version: 2, exportedAt: new Date().toISOString(), recoveredFromClinic: true, patients: r.patients, visits: r.visits, audio: r.audio });
