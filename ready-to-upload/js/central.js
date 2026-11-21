// Client for the clinic backend (Supabase free tier): sign-in, directory/approval, and encrypted record storage.
// Uses plain fetch (no third-party scripts). The server is sent only a LOGIN SECRET derived from the password --
// never the password and never the data key -- and stores only ciphertext. All reads/writes go through the
// checked SQL functions in supabase/schema.sql.
import { CLINIC } from './config.js';
import { DbxError } from './dropbox.js';

export const enabled = () => !!(CLINIC.supabaseUrl && CLINIC.anonKey);
export const clinicName = () => CLINIC.clinicName || 'your clinic';
export const offlineDays = () => Number(CLINIC.offlineDays) > 0 ? Number(CLINIC.offlineDays) : 7; // how long the app may be used offline between clinic check-ins
const base = () => CLINIC.supabaseUrl.replace(/\/+$/, '');

export class CentralError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const FRIENDLY = {
  not_active: 'Your clinic account is not active.',
  not_admin: 'Only clinic administrators can do that.',
  bad_request: 'The clinic server rejected that request.',
  cannot_change_self: 'You can’t change your own access.',
  disable_first: 'Disable the person first, then remove them.',
  last_admin: 'You are the only administrator — make someone else an admin first.',
  clinic_not_ready: 'Your clinic hasn’t finished setting up yet. Ask your administrator to complete the recovery-key setup, then try again.',
  escrow_required: 'Your account is missing its clinic recovery seal. Please sign in again to finish.',
  target_not_disabled: 'Recovery is only available for accounts that have been disabled. Disable the person first.',
  not_found: 'That person no longer exists.',
};
function toError(status, d) {
  const msg = String(d?.message || d?.msg || d?.error_description || d?.error || '');
  const code = String(d?.error_code || d?.code || '');
  const all = code + ' ' + msg;
  if (/banned/i.test(all)) return new CentralError(status, 'disabled', 'Your access to the clinic has been disabled. Please contact your clinic administrator.');
  if (/user_already_exists|already registered/i.test(all)) return new CentralError(status, 'exists', 'That email already has an account. Sign in instead.');
  if (/invalid_credentials|invalid login|invalid_grant|refresh_token_not_found|invalid refresh/i.test(all)) return new CentralError(status, 'bad_credentials', 'Incorrect email or password.');
  if (status === 429 || /rate.?limit/i.test(all)) return new CentralError(status, 'rate', 'Too many attempts — please wait a minute and try again.');
  if (/weak_password|password.*(short|weak)/i.test(all)) return new CentralError(status, 'weak', msg);
  if (FRIENDLY[msg]) return new CentralError(status, msg, FRIENDLY[msg]);
  return new CentralError(status, code || 'error', msg || `Clinic server error (${status})`);
}

let sess = null;   // { access, refresh, expiresAt, userId, email }
let secret = null; // login secret, kept in memory only while the app is unlocked
export const hasSession = () => !!sess;
export const sessionEmail = () => sess?.email || null;
export const currentSecret = () => secret;
let primedEmail = null; // set when the app was opened offline: sign in to the clinic later with the in-memory secret
export function prime(email, loginSecret) { primedEmail = email; secret = loginSecret; }
export function clear() { sess = null; secret = null; primedEmail = null; }

async function http(path, { method = 'POST', body, token, query = '' } = {}) {
  const res = await fetch(base() + path + query, {
    method,
    headers: { apikey: CLINIC.anonKey, Authorization: `Bearer ${token || CLINIC.anonKey}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw toError(res.status, data);
  return data;
}

function store(d) {
  sess = { access: d.access_token, refresh: d.refresh_token, expiresAt: Date.now() + (d.expires_in || 3600) * 1000 - 60000, userId: d.user?.id, email: (d.user?.email || sess?.email || '').toLowerCase() };
}

// ---- sign-in -------------------------------------------------------------------------------------------------
// The clinic's recovery PUBLIC key ({jwk, kid}) or null if the administrator hasn't set it up yet.
export const clinicKey = () => http('/rest/v1/rpc/clinic_public_key', { body: { p: {} } });
export const kdfParams = (email) => http('/rest/v1/rpc/kdf_params', { body: { p: { email } } });

export async function signUp(email, loginSecret) {
  const d = await http('/auth/v1/signup', { body: { email, password: loginSecret } });
  if (!d?.access_token) throw new CentralError(0, 'confirm_email', 'The clinic server wants email confirmation. In Supabase: Authentication → Sign In / Providers → Email → turn OFF "Confirm email".');
  store(d); secret = loginSecret;
}
export async function signIn(email, loginSecret) {
  const d = await http('/auth/v1/token', { query: '?grant_type=password', body: { email, password: loginSecret } });
  store(d); secret = loginSecret;
}
async function refresh() { store(await http('/auth/v1/token', { query: '?grant_type=refresh_token', body: { refresh_token: sess.refresh } })); }
async function accessToken() {
  if (!sess) {
    if (secret && primedEmail) await signIn(primedEmail, secret);   // throws TypeError while still offline
    else throw new CentralError(0, 'no_session', 'Not signed in to the clinic.');
  }
  if (Date.now() >= sess.expiresAt) {
    try { await refresh(); }
    catch (e) { if (secret && e.code !== 'disabled') await signIn(sess.email, secret); else throw e; }
  }
  return sess.access;
}
export async function signOut() { try { if (sess) await http('/auth/v1/logout', { token: sess.access }); } catch { /* ignore */ } clear(); }

export async function updatePassword(newLoginSecret, token) {
  await http('/auth/v1/user', { method: 'PUT', body: { password: newLoginSecret }, token: token || (await accessToken()) });
  secret = newLoginSecret;
}

// ---- password-reset email ------------------------------------------------------------------------------------
export const recoverEmail = (email, redirectTo) => http('/auth/v1/recover', { body: { email }, query: `?redirect_to=${encodeURIComponent(redirectTo)}` });
// Call at page load: if the reset link in the email just brought the user back, adopts that session and returns {email}.
export async function takeRecoveryReturn() {
  if (!/^#(access_token|error)=/.test(location.hash)) return null;
  const p = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname + location.search);
  if (p.get('error')) return { error: (p.get('error_description') || 'That reset link is invalid or has expired.').replace(/\+/g, ' ') };
  if (p.get('type') !== 'recovery') return null;
  const u = await http('/auth/v1/user', { method: 'GET', token: p.get('access_token') });
  store({ access_token: p.get('access_token'), refresh_token: p.get('refresh_token'), expires_in: +p.get('expires_in') || 3600, user: u });
  return { email: u.email };
}

// ---- checked server functions ----------------------------------------------------------------------------------
export async function rpc(fn, args = {}) {
  for (let i = 0; ; i++) {
    try { return await http(`/rest/v1/rpc/${fn}`, { token: await accessToken(), body: { p: args } }); }
    catch (e) { if (e.status === 401 && i === 0 && sess) { sess.expiresAt = 0; continue; } throw e; }
  }
}

// ---- storage adapter: lets the sync engine treat the clinic database like a cloud folder -------------------------
const parsePath = (p) => { const m = /^\/[^/]+\/([pvas])\/([^/]+)\.json$/.exec(p); if (!m) throw new Error('bad path ' + p); return { k: m[1], id: m[2] }; };

export class CentralStore {
  constructor(acct) { this.acct = String(acct); }
  #entry(it) {
    const path = `/${this.acct}/${it.k}/${it.id}.json`;
    return { '.tag': it.d ? 'deleted' : 'file', name: `${it.id}.json`, path_lower: path.toLowerCase(), path_display: path, rev: String(it.seq) };
  }
  async #pages(since, deleted) {
    const entries = [];
    let cur = since;
    for (;;) {
      const r = await rpc('sync_changes', { since: cur, deleted });
      for (const it of r.items) { entries.push(this.#entry(it)); cur = it.seq; }
      if (!r.more) break;
    }
    return { entries, cursor: String(cur) };
  }
  list() { return this.#pages(0, false); }
  changes(cursor) { return this.#pages(Number(cursor) || 0, true); }
  async download(path) {
    const { k, id } = parsePath(path);
    const r = await rpc('sync_get', { k, id });
    if (!r) throw new DbxError(409, 'path/not_found/');
    return r.body;
  }
  async upload(path, text, rev) {
    if (path.endsWith('/account.json')) { await rpc('update_account_blob', { blob: JSON.parse(text) }); return { rev: '0' }; }
    const { k, id } = parsePath(path);
    const r = await rpc('sync_put', { k, id, body: text, base: rev && rev !== 'any' ? Number(rev) : null });
    if (!r.ok) throw new DbxError(409, 'path/conflict/file/');
    return { rev: String(r.seq) };
  }
  async delete(path) { const { k, id } = parsePath(path); await rpc('sync_delete', { k, id }); }
}
