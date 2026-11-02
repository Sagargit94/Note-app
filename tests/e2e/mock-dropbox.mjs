// A small in-memory imitation of the Dropbox HTTP API subset PhysioNotes uses (OAuth PKCE, list_folder, continue,
// download, upload with add/update/overwrite modes, delete_v2). For local testing only: node mock-dropbox.mjs 9090
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

export function startMock(port = 9090) {
  const files = new Map();       // path_lower -> { display, body, rev, idx, deleted }
  const codes = new Map();       // code -> { challenge }
  const tokens = new Map();      // access token -> true
  const refresh = new Set();
  let idx = 0;
  const cfg = { expires: 14400, calls: [], authCount: 0 };

  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Dropbox-API-Arg', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Expose-Headers': 'Dropbox-API-Result' };
  const send = (res, status, body, type = 'application/json') => { res.writeHead(status, { ...cors, 'Content-Type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  const err = (res, status, summary) => send(res, status, { error_summary: summary, error: { '.tag': summary.split('/')[0] } });
  const rev = () => randomBytes(8).toString('hex');
  const entry = (f, p) => f.deleted ? { '.tag': 'deleted', name: f.display.split('/').pop(), path_lower: p, path_display: f.display }
    : { '.tag': 'file', name: f.display.split('/').pop(), path_lower: p, path_display: f.display, rev: f.rev, size: f.body.length };
  const under = (p, root) => root === '' || p.startsWith(root.toLowerCase() + '/');
  const folderExists = (root) => root === '' || [...files.entries()].some(([p, f]) => !f.deleted && p.startsWith(root.toLowerCase() + '/'));
  const listing = (root, recursive, since) => {
    const out = [];
    const seenFolders = new Set();
    for (const [p, f] of files) {
      if (!under(p, root)) continue;
      if (since !== null && f.idx <= since) continue;
      if (recursive || since !== null) { if (f.deleted && since === null) continue; out.push(entry(f, p)); continue; }
      const rest = p.slice(root.length + 1).split('/');
      if (f.deleted) continue;
      if (rest.length === 1) out.push(entry(f, p));
      else if (!seenFolders.has(rest[0])) { seenFolders.add(rest[0]); out.push({ '.tag': 'folder', name: f.display.slice(root.length + 1).split('/')[0], path_lower: `${root.toLowerCase()}/${rest[0]}` }); }
    }
    return out;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (req.method === 'OPTIONS') return send(res, 204, '');
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    cfg.calls.push(`${req.method} ${url.pathname}`);

    if (url.pathname === '/oauth2/authorize') {
      const code = randomBytes(8).toString('hex');
      codes.set(code, { challenge: url.searchParams.get('code_challenge'), method: url.searchParams.get('code_challenge_method') });
      cfg.authCount++;
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', code); back.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { Location: back.toString() }); return res.end();
    }
    if (url.pathname === '/oauth2/token') {
      const f = new URLSearchParams(raw);
      const access = randomBytes(12).toString('hex');
      if (f.get('grant_type') === 'authorization_code') {
        const c = codes.get(f.get('code'));
        if (!c) return send(res, 400, { error: 'invalid_grant', error_description: 'bad code' });
        const want = createHash('sha256').update(f.get('code_verifier') || '').digest('base64url');
        if (c.method !== 'S256' || want !== c.challenge) return send(res, 400, { error: 'invalid_grant', error_description: 'PKCE mismatch' });
        codes.delete(f.get('code'));
        const r = 'R' + randomBytes(10).toString('hex'); refresh.add(r); tokens.set(access, true);
        return send(res, 200, { access_token: access, refresh_token: r, expires_in: cfg.expires, token_type: 'bearer' });
      }
      if (f.get('grant_type') === 'refresh_token' && refresh.has(f.get('refresh_token'))) { tokens.set(access, true); return send(res, 200, { access_token: access, expires_in: cfg.expires, token_type: 'bearer' }); }
      return send(res, 400, { error: 'invalid_grant' });
    }
    if (url.pathname.startsWith('/__')) { // test admin
      if (url.pathname === '/__state') return send(res, 200, { calls: cfg.calls, files: [...files].filter(([, f]) => !f.deleted).map(([p, f]) => ({ path: p, body: f.body })) });
      if (url.pathname === '/__expires') { cfg.expires = +url.searchParams.get('s'); return send(res, 200, {}); }
      if (url.pathname === '/__revoke') { tokens.clear(); refresh.clear(); return send(res, 200, {}); }
      return send(res, 404, {});
    }

    const bearer = (req.headers.authorization || '').replace('Bearer ', '');
    if (!tokens.has(bearer)) return send(res, 401, { error_summary: 'invalid_access_token/', error: { '.tag': 'invalid_access_token' } });

    if (url.pathname === '/2/files/list_folder') {
      const a = JSON.parse(raw);
      if (!folderExists(a.path)) return err(res, 409, 'path/not_found/..');
      return send(res, 200, { entries: listing(a.path, a.recursive, null), cursor: `${idx}|${a.path}`, has_more: false });
    }
    if (url.pathname === '/2/files/list_folder/continue') {
      const a = JSON.parse(raw);
      const [i, path] = String(a.cursor).split('|');
      if (i === undefined || isNaN(+i)) return err(res, 409, 'reset/..');
      return send(res, 200, { entries: listing(path, true, +i), cursor: `${idx}|${path}`, has_more: false });
    }
    if (url.pathname === '/2/files/download') {
      const a = JSON.parse(req.headers['dropbox-api-arg']);
      const f = files.get(a.path.toLowerCase());
      if (!f || f.deleted) return err(res, 409, 'path/not_found/..');
      res.writeHead(200, { ...cors, 'Content-Type': 'application/octet-stream', 'Dropbox-API-Result': JSON.stringify({ rev: f.rev }) });
      return res.end(f.body);
    }
    if (url.pathname === '/2/files/upload') {
      const a = JSON.parse(req.headers['dropbox-api-arg']);
      const p = a.path.toLowerCase();
      const f = files.get(p);
      const exists = f && !f.deleted;
      if (a.mode['.tag'] === 'add' && exists) return err(res, 409, 'path/conflict/file/..');
      if (a.mode['.tag'] === 'update' && (!exists || f.rev !== a.mode.update)) return err(res, 409, 'path/conflict/file/..');
      const r = rev();
      files.set(p, { display: a.path, body: raw, rev: r, idx: ++idx, deleted: false });
      return send(res, 200, { name: a.path.split('/').pop(), path_lower: p, path_display: a.path, rev: r, size: raw.length });
    }
    if (url.pathname === '/2/files/delete_v2') {
      const a = JSON.parse(raw);
      const p = a.path.toLowerCase();
      const hits = [...files].filter(([k, f]) => !f.deleted && (k === p || k.startsWith(p + '/')));
      if (!hits.length) return err(res, 409, 'path_lookup/not_found/..');
      for (const [, f] of hits) { f.deleted = true; f.idx = ++idx; }
      return send(res, 200, { metadata: { '.tag': 'file', name: p } });
    }
    return send(res, 404, { error_summary: 'unknown/' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, cfg, close: () => server.close() })));
}

if (process.argv[1] && process.argv[1].endsWith('mock-dropbox.mjs')) {
  const m = await startMock(Number(process.argv[2]) || 9090);
  console.log('mock Dropbox on', m.server.address().port);
}
