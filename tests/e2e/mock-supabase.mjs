// Test double for Supabase: GoTrue-style auth endpoints + PostgREST-style RPC, running on a REAL Postgres with the
// real supabase/schema.sql, so access rules are exercised for real. Needs PGHOST/PGPORT/PGUSER like psql.
import { createServer } from 'node:http';
import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const b64u = (b) => Buffer.from(b).toString('base64url');
const hash = (pw) => { const s = randomBytes(8).toString('hex'); return `${s}:${scryptSync(pw, s, 32).toString('hex')}`; };
const check = (pw, h) => { const [s, x] = h.split(':'); return timingSafeEqual(scryptSync(pw, s, 32), Buffer.from(x, 'hex')); };

export async function startSupabase({ port = 9100, adminEmail = 'boss@clinic.test' } = {}) {
  const dbName = 'mock_' + randomBytes(4).toString('hex');
  const root = new pg.Client({ database: 'postgres' }); await root.connect();
  await root.query(`create database ${dbName}`);
  const setup = new pg.Client({ database: dbName }); await setup.connect();
  await setup.query(readFileSync(new URL('../db/auth-stub.sql', import.meta.url), 'utf8'));
  await setup.query(readFileSync(new URL('../../supabase/schema.sql', import.meta.url), 'utf8').replace("constant text := 'EDIT-ME@example.com'", `constant text := '${adminEmail}'`));
  await setup.end();
  const pool = new pg.Pool({ database: dbName, max: 6 });

  const SECRET = randomBytes(32), ANON = 'test-anon-key';
  const cfg = { expires: 3600, signups: 0, calls: [] };
  const refreshTokens = new Map();   // token -> user id
  const recovery = new Map();        // email -> { jwt, refresh }

  const jwt = (u, exp = cfg.expires) => {
    const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const p = b64u(JSON.stringify({ sub: u.id, email: u.email, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + exp }));
    return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`;
  };
  const verify = (t) => {
    const [h, p, s] = String(t).split('.');
    if (!s || createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url') !== s) return null;
    const c = JSON.parse(Buffer.from(p, 'base64url').toString());
    return c.exp * 1000 > Date.now() ? c : 'expired';
  };
  const session = (u) => { const rt = randomBytes(12).toString('hex'); refreshTokens.set(rt, u.id); return { access_token: jwt(u), token_type: 'bearer', expires_in: cfg.expires, refresh_token: rt, user: { id: u.id, email: u.email } }; };

  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, prefer', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS' };
  const send = (res, status, body) => { res.writeHead(status, { ...cors, 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
  const q = async (sql, args) => (await pool.query(sql, args)).rows;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const chunks = []; for await (const c of req) chunks.push(c);
    let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { /* none */ }
    const bearer = (req.headers.authorization || '').replace('Bearer ', '');
    cfg.calls.push(`${req.method} ${url.pathname}`);

    if (url.pathname.startsWith('/__')) {
      if (url.pathname === '/__expires') { cfg.expires = +url.searchParams.get('s'); return send(res, 200, {}); }
      if (url.pathname === '/__recovery') { const r = recovery.get(url.searchParams.get('email')); return send(res, 200, r ? { hash: `#access_token=${r.jwt}&expires_in=3600&refresh_token=${r.refresh}&token_type=bearer&type=recovery` } : {}); }
      return send(res, 404, {});
    }
    if (req.headers.apikey !== ANON) return send(res, 401, { message: 'No API key found in request' });

    // ---------- auth (GoTrue-like) ----------
    if (url.pathname === '/auth/v1/signup') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 422, { code: 422, error_code: 'validation_failed', msg: 'Unable to validate email address: invalid format' });
      if (String(body.password || '').length < 6) return send(res, 422, { code: 422, error_code: 'weak_password', msg: 'Password should be at least 6 characters.' });
      if ((await q('select 1 from auth.users where email=$1', [email])).length) return send(res, 422, { code: 422, error_code: 'user_already_exists', msg: 'User already registered' });
      const [u] = await q('insert into auth.users(email, encrypted_password) values ($1,$2) returning id,email', [email, hash(body.password)]);
      cfg.signups++;
      return send(res, 200, session(u));
    }
    if (url.pathname === '/auth/v1/token') {
      let u;
      if (url.searchParams.get('grant_type') === 'refresh_token') {
        const id = refreshTokens.get(body.refresh_token);
        if (!id) return send(res, 400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
        [u] = await q('select id,email,(banned_until is not null and banned_until > now()) as banned from auth.users where id=$1', [id]);
      } else {
        [u] = await q('select id,email,encrypted_password,(banned_until is not null and banned_until > now()) as banned from auth.users where email=$1', [String(body.email || '').trim().toLowerCase()]);
        if (!u || !check(String(body.password || ''), u.encrypted_password)) return send(res, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      }
      if (u?.banned) return send(res, 400, { code: 400, error_code: 'user_banned', msg: 'User is banned' });
      return u ? send(res, 200, session(u)) : send(res, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
    }
    if (url.pathname === '/auth/v1/user') {
      const c = verify(bearer);
      if (!c || c === 'expired') return send(res, 401, { code: 401, msg: 'invalid JWT' });
      if (req.method === 'PUT') { if (String(body.password || '').length < 6) return send(res, 422, { error_code: 'weak_password', msg: 'weak' }); await q('update auth.users set encrypted_password=$1 where id=$2', [hash(body.password), c.sub]); }
      return send(res, 200, { id: c.sub, email: c.email });
    }
    if (url.pathname === '/auth/v1/logout') return send(res, 204);
    if (url.pathname === '/auth/v1/recover') {
      const email = String(body.email || '').trim().toLowerCase();
      const [u] = await q('select id,email from auth.users where email=$1', [email]);
      if (u) { const s = session(u); recovery.set(email, { jwt: s.access_token, refresh: s.refresh_token }); }
      return send(res, 200, {});                                  // same answer whether or not the email exists
    }

    // ---------- PostgREST-like RPC ----------
    const m = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname);
    if (m) {
      let role = 'anon', claims = null;
      if (bearer !== ANON) {
        const c = verify(bearer);
        if (!c) return send(res, 401, { message: 'JWSError JWSInvalidSignature' });
        if (c === 'expired') return send(res, 401, { code: 'PGRST301', message: 'JWT expired' });
        role = 'authenticated'; claims = { sub: c.sub, email: c.email, role };
      }
      const c = await pool.connect();
      try {
        await c.query('begin'); await c.query(`set local role ${role}`);
        if (claims) await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(claims)]);
        const r = await c.query(`select public.${m[1]}($1::jsonb) as r`, [JSON.stringify(body.p ?? {})]);
        await c.query('commit');
        return send(res, 200, r.rows[0].r);
      } catch (e) {
        await c.query('rollback').catch(() => {});
        return send(res, e.code === '42501' ? (role === 'anon' ? 401 : 403) : 400, { code: e.code, message: e.message });
      } finally { c.release(); }
    }
    return send(res, 404, { message: 'not found' });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return {
    url: `http://localhost:${port}`, anonKey: ANON, pool, cfg, q,
    async close() { server.close(); await pool.end(); await root.query(`drop database if exists ${dbName} with (force)`); await root.end(); },
  };
}
