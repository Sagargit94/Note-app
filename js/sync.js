// End-to-end encrypted sync between this user's devices, via the user's own Dropbox app folder.
//   /<accountId>/account.json            public key material (wrapped keys, salts) so a new device can sign in
//   /<accountId>/{p|v|a|s}/<id>.json     one AES-GCM encrypted record per file (patients/visits/audio/settings)
// Dropbox only ever sees ciphertext + opaque ids. Conflicts never destroy data: when the same visit was edited on two
// devices, the newer version wins and the other is kept as a "conflict copy" for you to review.
import * as db from './db.js';
import * as C from './crypto.js';
import { Dropbox, DbxError } from './dropbox.js';
import { CentralStore } from './central.js';
import { uid } from './util.js';

const DIR = { patients: 'p', visits: 'v', audio: 'a', settings: 's' };
const NAME = { p: 'patients', v: 'visits', a: 'audio', s: 'settings' };
const ORDER = { patients: 0, visits: 1, audio: 2, settings: 3 };
const MAX_FILE = 18e6; // characters of JSON per record (Dropbox allows far more; keeps memory sane on phones)

let ctx = null; // { acct, dbx, onStatus, onRemote }
let running = null;
let again = false;
let timer = null;
let interval = null;
export const state = { status: 'off', last: null, msg: '' };
export let kind = 'off'; // 'dropbox' | 'clinic' | 'off'
export const isEnabled = () => !!ctx;

function setStatus(status, msg = '') {
  state.status = status; state.msg = msg;
  if (status === 'idle') state.last = Date.now();
  ctx?.onStatus?.({ ...state });
  window.dispatchEvent(new CustomEvent('sync-status', { detail: { ...state } }));
}

const pathOf = (acct, name, id) => `/${acct}/${DIR[name]}/${id}.json`;

// ---------- lifecycle ----------
export async function start(user, hooks = {}) {
  const dev = await db.get('settings', 'dropbox-device').catch(() => null);
  if (!dev?.tokens) { state.status = 'off'; return false; }
  attach(user.id, dev.tokens, hooks);
  schedule(300);
  return true;
}

function attach(acct, tokens, hooks = {}) {
  attachProvider(acct, new Dropbox(tokens, (t) => db.put('settings', { id: 'dropbox-device', tokens: t }).catch(() => {})), hooks);
  kind = 'dropbox';
}

// Clinic mode: the clinic database is the sync target (no Dropbox needed).
export async function startCentral(user, hooks = {}) {
  attachProvider(user.id, new CentralStore(user.id), hooks);
  kind = 'clinic';
  await db.seedDirty(); // idempotent: only records that have no sync bookkeeping yet
  schedule(300);
}

function attachProvider(acct, dbx, { onStatus, onRemote } = {}) {
  ctx = { acct: String(acct), dbx, onStatus, onRemote };
  db.setTracking(true, () => schedule());
  window.addEventListener('online', onNet);
  document.addEventListener('visibilitychange', onVis);
  interval = setInterval(() => { if (!document.hidden) syncNow(); }, 60000);
  setStatus('idle');
}
const onNet = () => syncNow();
const onVis = () => { if (!document.hidden) syncNow(); };

export async function stop() {
  if (!ctx) return;
  clearTimeout(timer); clearInterval(interval);
  window.removeEventListener('online', onNet);
  document.removeEventListener('visibilitychange', onVis);
  // give an in-flight/pending push a moment to finish so edits made just before locking reach Dropbox
  if (!running && navigator.onLine) syncNow();
  if (running) await Promise.race([running, new Promise((r) => setTimeout(r, 8000))]);
  db.setTracking(false);
  ctx = null; running = null; kind = 'off';
  state.status = 'off';
}

// Switch sync on for the signed-in account (tokens come from the Dropbox sign-in).
export async function enable(tokens, user, accountBlob, hooks = {}) {
  await db.put('settings', { id: 'dropbox-device', tokens });
  attach(user.id, tokens, hooks);
  await db.seedDirty();
  setStatus('syncing');
  await ctx.dbx.upload(`/${ctx.acct}/account.json`, JSON.stringify(accountBlob), 'any');
  await syncNow();
}

export async function disable({ deleteRemote = false } = {}) {
  if (!ctx) return;
  const { dbx, acct } = ctx;
  await stop();
  if (deleteRemote) await dbx.delete(`/${acct}`);
  await db.del('settings', 'dropbox-device');
  await db.clearSyncMeta();
  state.status = 'off';
}

export async function pushAccount(blob) {
  if (ctx) await ctx.dbx.upload(`/${ctx.acct}/account.json`, JSON.stringify(blob), 'any');
}

// For a brand-new device: which accounts exist in this Dropbox?
export async function findAccounts(tokens) {
  const dbx = new Dropbox(tokens);
  const { entries } = await dbx.list('');
  const out = [];
  for (const e of entries.filter((x) => x['.tag'] === 'folder')) {
    try { out.push(JSON.parse(await dbx.download(`/${e.name}/account.json`))); } catch { /* not ours */ }
  }
  return out;
}

// ---------- scheduling ----------
export function schedule(ms = 4000) {
  if (!ctx) return;
  clearTimeout(timer);
  timer = setTimeout(syncNow, ms);
}
export function syncNow() {
  if (!ctx) return Promise.resolve();
  if (running) { again = true; return running; }
  running = (async () => {
    try { do { again = false; await cycle(); } while (again && ctx); }
    finally { running = null; }
  })();
  return running;
}

async function cycle() {
  const c = ctx;
  if (!navigator.onLine) return setStatus('offline');
  setStatus('syncing');
  const changed = new Set();
  try {
    await pull(changed);
    let r = await push();
    if (r.conflicts) { await pull(changed); r = await push(); }
    if (r.n && !(await db.metaGet('cursor'))) await pull(changed); // first upload: pick up the cursor
    if (ctx !== c) return;
    setStatus(r.conflicts ? 'error' : 'idle', r.conflicts ? 'Some changes could not be synced yet; will retry.' : r.skipped ? `${r.skipped} recording(s) too large to sync.` : '');
    if (changed.size) ctx.onRemote?.(changed);
  } catch (e) {
    if (ctx !== c) return;
    if (e.code !== 'not_active' && e.code !== 'disabled') console.error('sync', e); // revoked access is an expected condition, not a bug
    if (e instanceof TypeError || !navigator.onLine) setStatus('offline');
    else setStatus('error', e.status === 401 || /invalid_grant|expired|revoked/.test(e.summary || '') ? 'Dropbox access was revoked or expired — reconnect in Settings.' : e.message);
  }
}

// ---------- pull ----------
async function pull(changed) {
  const { dbx, acct } = ctx;
  let cursor = (await db.metaGet('cursor'))?.value;
  let res = null;
  if (cursor) {
    try { res = await dbx.changes(cursor); } catch (e) { if (/reset/.test(e.summary)) cursor = null; else throw e; }
  }
  const full = !res;
  if (full) res = await dbx.list(`/${acct}`, { recursive: true });
  const seen = new Set();
  for (const e of res.entries) {
    const key = await applyEntry(e, changed);
    if (key) seen.add(key);
  }
  if (full) await reconcileFull(seen, changed);
  if (res.cursor) await db.metaPut({ id: 'cursor', value: res.cursor });
}

function parse(e) {
  const m = /^\/([^/]+)\/([pvas])\/([^/]+)\.json$/.exec(e.path_lower || '');
  if (!m || m[1] !== ctx.acct.toLowerCase()) return null;
  return { name: NAME[m[2]], id: m[3], key: `${m[2]}:${m[3]}` };
}

async function applyEntry(e, changed) {
  if (e['.tag'] === 'folder') return null;
  const t = parse(e);
  if (!t) return null;
  const { name, id, key } = t;
  const meta = await db.metaGet(key);

  if (e['.tag'] === 'deleted') {
    if (meta?.dirty && !meta.deleted) { await db.metaPut({ ...meta, rev: null }); return null; } // my edit wins over a remote delete
    if (await db.rawRow(name, id)) { await db.deleteSilently(name, id); changed.add(key); }
    if (meta) await db.metaDel(key);
    return null;
  }
  if (meta?.rev === e.rev) return key;                               // already have this exact revision
  if (meta?.dirty && meta.deleted) { await db.metaPut({ ...meta, rev: e.rev }); return key; } // I deleted it; push the delete

  const row = C.wireToRow(JSON.parse(await ctx.dbx.download(e.path_display || e.path_lower)).row);
  let remoteObj;
  try { remoteObj = await db.decryptRow(name, row); }
  catch { setStatus('error', 'Some synced records could not be decrypted (wrong account or damaged file).'); return key; }

  const cur = await db.metaGet(key); // re-read: the user may have edited while we were downloading
  if (!cur?.dirty) {
    await db.importRow(name, row);
    await db.metaPut({ id: key, store: name, rid: id, rev: e.rev, dirty: false, deleted: false, v: cur?.v || 0 });
    changed.add(key);
    return key;
  }
  await resolveConflict(name, id, key, cur, row, remoteObj, e.rev, changed);
  return key;
}

const stable = (o) => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
const strip = ({ updatedAt, conflictOf, conflictAt, blob, ...rest }) => rest; // eslint-disable-line no-unused-vars

async function resolveConflict(name, id, key, meta, remoteRow, remoteObj, remoteRev, changed) {
  const localObj = await db.get(name, id);
  if (!localObj || (name !== 'audio' && stable(strip(localObj)) === stable(strip(remoteObj)))) {
    // identical content (e.g. both devices uploaded the same record) -> just adopt the remote revision
    await db.metaPut({ ...meta, rev: remoteRev, dirty: false });
    return;
  }
  const takeRemote = async () => { await db.importRow(name, remoteRow); await db.metaPut({ id: key, store: name, rid: id, rev: remoteRev, dirty: false, deleted: false, v: meta.v }); changed.add(key); };
  const keepLocal = () => db.metaPut({ ...meta, rev: remoteRev, dirty: true }); // next push overwrites on top of the remote revision
  if (name === 'audio') return takeRemote();
  const remoteNewer = (remoteObj.updatedAt || '') > (localObj.updatedAt || '');
  if (name === 'patients' || name === 'settings') return remoteNewer ? takeRemote() : keepLocal();
  // visits: never lose text. Newer version stays; the older becomes a draft "conflict copy".
  const loser = remoteNewer ? localObj : remoteObj;
  if (remoteNewer) await takeRemote(); else await keepLocal();
  await db.put('visits', { ...loser, id: uid(), status: 'draft', conflictOf: id, conflictAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  changed.add(key);
}

// After a full re-list (first sync or reset cursor): detect records deleted remotely, or a wiped remote.
async function reconcileFull(seen, changed) {
  const metas = (await db.metaAll()).filter((m) => m.id !== 'cursor' && m.rev && !m.dirty);
  if (!seen.size && metas.length) { // remote is empty but we had synced before: re-upload rather than delete local data
    for (const m of metas) await db.metaPut({ ...m, rev: null, dirty: true });
    return;
  }
  for (const m of metas) {
    if (!seen.has(m.id)) {
      if (await db.rawRow(m.store, m.rid)) { await db.deleteSilently(m.store, m.rid); changed.add(m.id); }
      await db.metaDel(m.id);
    }
  }
}

// ---------- push ----------
async function push() {
  const { dbx, acct } = ctx;
  const dirty = (await db.metaAll()).filter((m) => m.id !== 'cursor' && m.dirty).sort((a, b) => ORDER[a.store] - ORDER[b.store]);
  let n = 0, conflicts = 0, skipped = 0;
  for (const m of dirty) {
    if (!ctx) break;
    const path = pathOf(acct, m.store, m.rid);
    try {
      if (m.deleted) {
        await dbx.delete(path);
        await finish(m, null);
      } else {
        const row = await db.rawRow(m.store, m.rid);
        if (!row) { await db.metaDel(m.id); continue; }
        const text = JSON.stringify({ v: 1, row: C.rowToWire(row) });
        if (text.length > MAX_FILE) { skipped++; await db.metaPut({ ...m, dirty: false, skipped: true }); continue; }
        const r = await dbx.upload(path, text, m.rev);
        await finish(m, r.rev);
      }
      n++;
    } catch (e) {
      if (e instanceof DbxError && (e.conflict || e.notFound)) { conflicts++; continue; }
      throw e;
    }
  }
  return { n, conflicts, skipped };
}

async function finish(m, rev) {
  const cur = await db.metaGet(m.id);
  if (!cur) return;
  if (cur.v === m.v) { if (m.deleted) await db.metaDel(m.id); else await db.metaPut({ ...cur, rev, dirty: false }); }
  else await db.metaPut({ ...cur, rev: m.deleted ? null : rev }); // edited again meanwhile: keep dirty, remember new rev
}
