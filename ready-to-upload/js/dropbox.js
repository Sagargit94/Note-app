// Minimal Dropbox HTTP client for a browser-only app: OAuth2 code flow with PKCE (no client secret),
// refresh tokens, and the handful of file calls sync needs. Only ENCRYPTED files are ever uploaded.
// Everything Dropbox-specific lives here so the sync engine stays provider-agnostic.
import { b64e, randomBytes } from './crypto.js';

const REAL = { api: 'https://api.dropboxapi.com', content: 'https://content.dropboxapi.com', auth: 'https://www.dropbox.com' };
// Tests may point at a local mock, but only ever at localhost (the CSP enforces this too).
function hosts() {
  try {
    const o = localStorage.getItem('physio-dbx-base');
    if (o && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(o)) return { api: o, content: o, auth: o };
  } catch { /* ignore */ }
  return REAL;
}

export const redirectUri = () => location.origin + location.pathname;
const b64url = (buf) => b64e(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export class DbxError extends Error {
  constructor(status, summary, body) { super(`Dropbox ${status}: ${summary || 'error'}`); this.status = status; this.summary = summary || ''; this.body = body; }
  get notFound() { return /not_found/.test(this.summary); }
  get conflict() { return /conflict/.test(this.summary); }
}

// ---------- sign-in (PKCE) ----------
export async function beginAuth(appKey, intent) {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = b64url(randomBytes(16));
  sessionStorage.setItem('dbx-oauth', JSON.stringify({ verifier, state, appKey, intent, redirect: redirectUri() }));
  const q = new URLSearchParams({ client_id: appKey, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', token_access_type: 'offline', redirect_uri: redirectUri(), state });
  location.assign(`${hosts().auth}/oauth2/authorize?${q}`);
}

// Call once at page load: if Dropbox just redirected back here, returns {code,...} or {error}. Strips the query string.
export function takeAuthReturn() {
  const p = new URLSearchParams(location.search);
  if (!p.has('code') && !p.has('error')) return null;
  history.replaceState(null, '', location.pathname + location.hash);
  let saved;
  try { saved = JSON.parse(sessionStorage.getItem('dbx-oauth') || 'null'); } catch { saved = null; }
  sessionStorage.removeItem('dbx-oauth');
  if (!saved || p.get('state') !== saved.state) return { error: 'The Dropbox sign-in could not be verified. Please try connecting again.' };
  if (p.has('error')) return { error: p.get('error_description') || 'Dropbox sign-in was cancelled.' };
  return { code: p.get('code'), ...saved };
}

async function tokenRequest(params) {
  const res = await fetch(`${hosts().api}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new DbxError(res.status, body.error_description || body.error, body);
  return body;
}
export async function exchangeCode({ code, verifier, appKey, redirect }) {
  const t = await tokenRequest({ code, grant_type: 'authorization_code', client_id: appKey, code_verifier: verifier, redirect_uri: redirect });
  if (!t.refresh_token) throw new Error('Dropbox did not return a long-lived sign-in. Check the app was created with "Scoped access" and try again.');
  return { appKey, refresh: t.refresh_token, access: t.access_token, expiresAt: Date.now() + (t.expires_in || 14400) * 1000 - 60000 };
}

// ---------- API client ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const asciiJson = (o) => JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

export class Dropbox {
  // tokens: { appKey, refresh, access, expiresAt }; onTokens(tokens) persists refreshed tokens
  constructor(tokens, onTokens = () => {}) { this.t = tokens; this.onTokens = onTokens; }

  async token() {
    if (!this.t.access || Date.now() >= this.t.expiresAt) {
      const r = await tokenRequest({ grant_type: 'refresh_token', refresh_token: this.t.refresh, client_id: this.t.appKey });
      this.t = { ...this.t, access: r.access_token, expiresAt: Date.now() + (r.expires_in || 14400) * 1000 - 60000 };
      this.onTokens(this.t);
    }
    return this.t.access;
  }

  async #call(url, init, tries = 4) {
    for (let i = 0; ; i++) {
      const res = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${await this.token()}` } });
      if (res.status === 429 && i < tries) { await sleep(((+res.headers.get('Retry-After') || 1) + i) * 1000); continue; }
      if (res.status === 401 && i === 0) { this.t.access = null; continue; } // expired token: refresh once
      if (res.ok) return res;
      let body = null;
      try { body = await res.clone().json(); } catch { body = { error_summary: (await res.text().catch(() => '')).slice(0, 120) }; }
      throw new DbxError(res.status, body?.error_summary || body?.error_description || '', body);
    }
  }

  async rpc(endpoint, args) {
    const res = await this.#call(`${hosts().api}/2/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
    return res.json();
  }
  // Lists everything under path (non-recursive unless asked). Returns {entries, cursor}. Missing folder -> empty.
  async list(path, { recursive = false } = {}) {
    let r;
    try { r = await this.rpc('files/list_folder', { path, recursive, limit: 500, include_deleted: false }); }
    catch (e) { if (e.notFound) return { entries: [], cursor: null }; throw e; }
    const entries = [...r.entries];
    while (r.has_more) { r = await this.rpc('files/list_folder/continue', { cursor: r.cursor }); entries.push(...r.entries); }
    return { entries, cursor: r.cursor };
  }
  // Changes since cursor (includes deleted entries). Throws DbxError with summary 'reset' if the cursor is stale.
  async changes(cursor) {
    let r = await this.rpc('files/list_folder/continue', { cursor });
    const entries = [...r.entries];
    while (r.has_more) { r = await this.rpc('files/list_folder/continue', { cursor: r.cursor }); entries.push(...r.entries); }
    return { entries, cursor: r.cursor };
  }
  async download(path) {
    const res = await this.#call(`${hosts().content}/2/files/download`, { method: 'POST', headers: { 'Dropbox-API-Arg': asciiJson({ path }) } });
    return res.text();
  }
  // rev: null -> create only (fails if it exists); string -> overwrite only if rev still matches; 'any' -> overwrite
  async upload(path, text, rev) {
    const mode = rev === 'any' ? { '.tag': 'overwrite' } : rev ? { '.tag': 'update', update: rev } : { '.tag': 'add' };
    const res = await this.#call(`${hosts().content}/2/files/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': asciiJson({ path, mode, autorename: false, mute: true }) },
      body: text,
    });
    const meta = await res.json();
    // If Dropbox ever resolves a conflict by renaming instead of failing, treat it as a conflict.
    if (meta.path_lower && meta.path_lower !== path.toLowerCase()) {
      try { await this.delete(meta.path_lower); } catch { /* best effort */ }
      throw new DbxError(409, 'path/conflict/renamed');
    }
    return meta; // { rev, ... }
  }
  async delete(path) {
    try { await this.rpc('files/delete_v2', { path }); } catch (e) { if (!e.notFound) throw e; }
  }
}
