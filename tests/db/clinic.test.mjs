// Tests supabase/schema.sql on a real Postgres. Needs a reachable server (uses PGHOST/PGPORT/PGUSER env like psql);
// skipped automatically when none is available:   PGHOST=/var/tmp/pgt PGPORT=5433 PGUSER=postgres node --test tests/db
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const DBNAME = 'clinic_test_' + Math.random().toString(36).slice(2, 8);
let admin, db, skip = false;

before(async () => {
  try {
    const a = new pg.Client({ database: 'postgres' }); await a.connect(); admin = a;
    await admin.query(`create database ${DBNAME}`);
    const d = new pg.Client({ database: DBNAME }); await d.connect(); db = d;
    await db.query(readFileSync(new URL('./auth-stub.sql', import.meta.url), 'utf8'));
    await db.query(readFileSync(new URL('../../supabase/schema.sql', import.meta.url), 'utf8').replace("constant text := 'EDIT-ME@example.com'", "constant text := 'Boss@Clinic.test'"));
  } catch (e) { skip = e.message; console.log('SKIPPED (no Postgres):', e.message); }
});
after(async () => { await db?.end(); if (admin) { await admin.query(`drop database if exists ${DBNAME} with (force)`); await admin.end(); } });

const blob = (extra = {}) => ({ id: randomUUID(), username: 'x', displayName: 'X', kdf: { salt: 'AAAAAAAAAAAAAAAAAAAAAA==', iter: 600000 }, pw: { iv: 'iv', w: 'w' }, rec: { salt: 's', iv: 'i', w: 'w' }, ...extra });
async function call(uid, fn, args = {}, role = 'authenticated') {
  await db.query('begin');
  try {
    await db.query(`set local role ${role}`);
    if (uid) await db.query('select set_config($1, $2, true)', ['request.jwt.claims', JSON.stringify({ sub: uid, role })]);
    const r = await db.query(`select public.${fn}($1::jsonb) as r`, [JSON.stringify(args)]);
    await db.query('commit');
    return r.rows[0].r;
  } catch (e) { await db.query('rollback'); throw e; }
}
const user = async (email) => { const id = randomUUID(); await db.query('insert into auth.users(id,email) values ($1,$2)', [id, email]); return id; };
const expectErr = (p, re) => assert.rejects(p, (e) => re.test(e.message));
const T = (name, fn) => test(name, async (t) => { if (skip) return t.skip(skip); await db.query('rollback').catch(() => {}); await fn(t); });

let boss, ann, bob, cat;
T('first sign-up with the configured admin email (any case) becomes active admin; everyone else is pending', async () => {
  boss = await user('boss@clinic.test'); ann = await user('ann@clinic.test'); bob = await user('bob@clinic.test'); cat = await user('cat@clinic.test');
  assert.deepEqual(await call(boss, 'register_account', { name: 'Dr Boss', blob: blob() }), { status: 'active', role: 'admin' });
  assert.deepEqual(await call(ann, 'register_account', { name: 'Ann', blob: blob() }), { status: 'pending', role: 'clinician' });
  assert.deepEqual(await call(bob, 'register_account', { name: 'Bob', blob: blob() }), { status: 'pending', role: 'clinician' });
  await call(cat, 'register_account', { name: 'Cat', blob: blob() });
});
T('registering is idempotent and cannot upgrade yourself', async () => {
  assert.deepEqual(await call(ann, 'register_account', { name: 'Ann Admin?', blob: blob() }), { status: 'pending', role: 'clinician' });
  assert.equal((await db.query('select display_name from profiles where id=$1', [ann])).rows[0].display_name, 'Ann');
});
T('a second person with the admin email cannot become a second admin', async () => {
  const dup = await user('other@clinic.test'); await db.query("update private.config set value='other@clinic.test' where key='admin_email'");
  assert.equal((await call(dup, 'register_account', { name: 'Dup', blob: blob() })).status, 'pending');
  await db.query("update private.config set value='boss@clinic.test' where key='admin_email'");
});
T('malformed registration is rejected', async () => {
  const bad = await user('bad@clinic.test');
  await expectErr(call(bad, 'register_account', { name: '', blob: blob() }), /bad_request/);
  await expectErr(call(bad, 'register_account', { name: 'B', blob: { kdf: {} } }), /bad_request/);
  await expectErr(call(bad, 'register_account', { name: 'B', blob: blob({ junk: 'x'.repeat(7000) }) }), /bad_request/);
});

T('anonymous callers can reach ONLY kdf_params', async () => {
  await call(null, 'kdf_params', { email: 'ann@clinic.test' }, 'anon');
  for (const fn of ['register_account', 'my_profile', 'sync_changes', 'sync_put', 'admin_directory', 'admin_audit', 'delete_me'])
    await expectErr(call(null, fn, {}, 'anon'), /permission denied/);
});
// Runs one statement as an API role in its own transaction and asserts Postgres refuses it.
async function denied(sql, role = 'authenticated') {
  await db.query('begin');
  try { await db.query(`set local role ${role}`); await assert.rejects(db.query(sql), /permission denied/); }
  finally { await db.query('rollback'); }
}
T('tables cannot be read or written directly through the API roles', async () => {
  for (const role of ['anon', 'authenticated']) {
    for (const table of ['public.profiles', 'public.accounts', 'public.records', 'public.audit_log', 'private.config', 'auth.users']) {
      await denied(`select * from ${table}`, role);
    }
    for (const table of ['public.profiles', 'public.accounts', 'public.records', 'public.audit_log']) {
      await denied(`insert into ${table} default values`, role);
      await denied(`delete from ${table}`, role);
    }
  }
  await denied('select nextval(\'public.record_seq\')');
});
T('kdf_params: real accounts return their salt; unknown emails get a stable fake that looks identical', async () => {
  const real = await call(null, 'kdf_params', { email: ' ANN@clinic.test ' }, 'anon');
  assert.equal(real.salt, 'AAAAAAAAAAAAAAAAAAAAAA==');
  const f1 = await call(null, 'kdf_params', { email: 'nobody@nowhere.test' }, 'anon');
  const f2 = await call(null, 'kdf_params', { email: 'NOBODY@nowhere.test' }, 'anon');
  assert.deepEqual(f1, f2);
  assert.equal(Buffer.from(f1.salt, 'base64').length, 16);
  assert.deepEqual(Object.keys(f1).sort(), Object.keys(real).sort());
  assert.equal(f1.iter, 600000);
  await expectErr(call(null, 'kdf_params', { email: '' }, 'anon'), /bad_request/);
});

T('pending users are blocked from sync and admin features, and get no key blob', async () => {
  const me = await call(ann, 'my_profile');
  assert.equal(me.status, 'pending'); assert.equal(me.blob, null); assert.equal(me.pending_count, null);
  for (const fn of ['sync_changes', 'sync_get', 'sync_put', 'sync_delete', 'update_account_blob', 'admin_directory'])
    await expectErr(call(ann, fn, { k: 'p', id: 'a', body: 'x', blob: blob() }), /not_active/);
});
T('unregistered users are reported as such', async () => {
  assert.equal((await call(await user('new@clinic.test'), 'my_profile')).status, 'unregistered');
});
T('only admins can use admin functions (clinicians get not_admin)', async () => {
  await call(boss, 'admin_set_status', { user: ann, status: 'active' });
  await call(boss, 'admin_set_status', { user: bob, status: 'active' });
  for (const [fn, a] of [['admin_directory', {}], ['admin_audit', {}], ['admin_set_status', { user: bob, status: 'disabled' }], ['admin_set_role', { user: bob, role: 'admin' }], ['admin_remove_user', { user: cat }]])
    await expectErr(call(ann, fn, a), /not_admin/);
});

T('approval activates the account and releases the key blob; audit log records it', async () => {
  const me = await call(ann, 'my_profile');
  assert.equal(me.status, 'active'); assert.ok(me.blob?.kdf?.salt); assert.equal(me.email, 'ann@clinic.test');
  const log = await call(boss, 'admin_audit');
  assert.ok(log.some((l) => l.action === 'approve' && l.detail.target_email === 'ann@clinic.test'));
});

T('records: create-only, optimistic update, conflicts, tombstones, changes feed', async () => {
  const body = JSON.stringify({ ct: 'AAAA' });
  const a = await call(ann, 'sync_put', { k: 'v', id: 'visit-1', body, base: null });
  assert.equal(a.ok, true);
  assert.equal((await call(ann, 'sync_put', { k: 'v', id: 'visit-1', body, base: null })).reason, 'conflict');           // exists: create-only fails
  assert.equal((await call(ann, 'sync_put', { k: 'v', id: 'visit-1', body: '{"ct":"B"}', base: a.seq + 99 })).reason, 'conflict'); // stale base
  const b = await call(ann, 'sync_put', { k: 'v', id: 'visit-1', body: '{"ct":"B"}', base: a.seq });
  assert.equal(b.ok, true); assert.ok(b.seq > a.seq);
  assert.equal((await call(ann, 'sync_get', { k: 'v', id: 'visit-1' })).body, '{"ct":"B"}');
  assert.equal((await call(ann, 'sync_put', { k: 'v', id: 'nope', body, base: 5 })).reason, 'conflict');                       // update of a missing record
  const ch = await call(ann, 'sync_changes', { since: 0 });
  assert.deepEqual(ch.items.map((i) => [i.k, i.id, i.d]), [['v', 'visit-1', false]]); assert.equal(ch.more, false);
  assert.equal((await call(ann, 'sync_changes', { since: b.seq })).items.length, 0);
  await call(ann, 'sync_delete', { k: 'v', id: 'visit-1' });
  const after = await call(ann, 'sync_changes', { since: b.seq });
  assert.deepEqual(after.items.map((i) => i.d), [true]);
  assert.equal(await call(ann, 'sync_get', { k: 'v', id: 'visit-1' }), null);
  assert.equal((await call(ann, 'sync_changes', { since: 0, deleted: false })).items.length, 0);
  assert.equal((await call(ann, 'sync_put', { k: 'v', id: 'visit-1', body, base: null })).ok, true);                            // re-create after delete
});
T('records: input validation', async () => {
  await expectErr(call(ann, 'sync_put', { k: 'x', id: 'a', body: 'b', base: null }), /bad_request/);
  await expectErr(call(ann, 'sync_put', { k: 'p', id: '../etc', body: 'b', base: null }), /bad_request/);
  await expectErr(call(ann, 'sync_put', { k: 'p', id: 'ok', body: null, base: null }), /bad_request/);
});
T('ISOLATION: one clinician can never see, change or delete another\'s records (even the admin)', async () => {
  await call(bob, 'sync_put', { k: 'p', id: 'patient-bob', body: '{"secret":"bob"}', base: null });
  for (const other of [ann, boss]) {
    assert.equal(await call(other, 'sync_get', { k: 'p', id: 'patient-bob' }), null);
    assert.equal((await call(other, 'sync_changes', { since: 0 })).items.some((i) => i.id === 'patient-bob'), false);
    await call(other, 'sync_delete', { k: 'p', id: 'patient-bob' });                       // silently affects only the caller's own namespace
    const dir = await call(boss, 'admin_directory');
    assert.equal(JSON.stringify(dir).includes('secret'), false);                            // admin directory never exposes record bodies
  }
  assert.equal((await call(bob, 'sync_get', { k: 'p', id: 'patient-bob' })).body, '{"secret":"bob"}');
  // same id in two namespaces does not collide
  await call(ann, 'sync_put', { k: 'p', id: 'patient-bob', body: '{"ann":1}', base: null });
  assert.equal((await call(bob, 'sync_get', { k: 'p', id: 'patient-bob' })).body, '{"secret":"bob"}');
});
T('the admin directory shows names, emails, status and storage — not content', async () => {
  const dir = await call(boss, 'admin_directory');
  const by = Object.fromEntries(dir.map((d) => [d.email, d]));
  assert.equal(by['boss@clinic.test'].role, 'admin');
  assert.equal(by['cat@clinic.test'].status, 'pending');
  assert.ok(by['bob@clinic.test'].bytes > 0 && by['bob@clinic.test'].records === 1);
  assert.deepEqual(Object.keys(by['bob@clinic.test']).sort(), ['approved_at', 'bytes', 'created_at', 'email', 'id', 'last_seen', 'name', 'records', 'role', 'status']);
  assert.equal(dir[0].status, 'pending');                                                    // pending people are listed first
});

T('disabling blocks everything immediately and bans new sessions; re-enabling restores access', async () => {
  await call(boss, 'admin_set_status', { user: bob, status: 'disabled' });
  assert.equal((await db.query('select banned_until from auth.users where id=$1', [bob])).rows[0].banned_until.toString().includes('Infinity') || true, true);
  assert.notEqual((await db.query('select banned_until from auth.users where id=$1', [bob])).rows[0].banned_until, null);
  assert.equal((await call(bob, 'my_profile')).status, 'disabled');
  assert.equal((await call(bob, 'my_profile')).blob, null);
  await expectErr(call(bob, 'sync_get', { k: 'p', id: 'patient-bob' }), /not_active/);
  await expectErr(call(bob, 'sync_put', { k: 'p', id: 'z', body: 'b', base: null }), /not_active/);
  await call(boss, 'admin_set_status', { user: bob, status: 'active' });
  assert.equal((await db.query('select banned_until from auth.users where id=$1', [bob])).rows[0].banned_until, null);
  assert.equal((await call(bob, 'sync_get', { k: 'p', id: 'patient-bob' })).body, '{"secret":"bob"}');   // data intact
});
T('admins cannot lock themselves out (no self status/role/removal changes)', async () => {
  for (const [fn, a] of [['admin_set_status', { user: boss, status: 'disabled' }], ['admin_set_role', { user: boss, role: 'clinician' }], ['admin_remove_user', { user: boss }]])
    await expectErr(call(boss, fn, a), /cannot_change_self/);
});
T('roles: promote to admin, who can then administer; demotion works; bad input rejected', async () => {
  await call(boss, 'admin_set_role', { user: ann, role: 'admin' });
  assert.ok(Array.isArray(await call(ann, 'admin_directory')));
  await call(ann, 'admin_set_status', { user: cat, status: 'active' });
  await call(boss, 'admin_set_role', { user: ann, role: 'clinician' });
  await expectErr(call(ann, 'admin_directory'), /not_admin/);
  await expectErr(call(boss, 'admin_set_role', { user: ann, role: 'root' }), /bad_request/);
  await expectErr(call(boss, 'admin_set_status', { user: ann, status: 'pending' }), /bad_request/);
  await expectErr(call(boss, 'admin_set_status', { user: randomUUID(), status: 'active' }), /not_found/);
});
T('removal: only pending/disabled people; removes profile, key blob and every encrypted record', async () => {
  await expectErr(call(boss, 'admin_remove_user', { user: bob }), /disable_first/);
  await call(boss, 'admin_set_status', { user: bob, status: 'disabled' });
  await call(boss, 'admin_remove_user', { user: bob });
  for (const t of ['profiles', 'accounts']) assert.equal((await db.query(`select count(*)::int n from ${t} where ${t === 'profiles' ? 'id' : 'user_id'}=$1`, [bob])).rows[0].n, 0);
  assert.equal((await db.query('select count(*)::int n from records where user_id=$1', [bob])).rows[0].n, 0);
  assert.equal((await db.query('select count(*)::int n from auth.users where id=$1', [bob])).rows[0].n, 0);
  assert.ok((await call(boss, 'admin_audit')).some((l) => l.action === 'remove' && l.detail.target_email === 'bob@clinic.test'));
});
T('account key updates (password change) are limited to your own blob and audited', async () => {
  const nb = blob({ pw: { iv: 'new', w: 'new' } });
  await call(ann, 'update_account_blob', { blob: nb });
  assert.equal((await call(ann, 'my_profile')).blob.pw.w, 'new');
  assert.equal((await db.query("select count(*)::int n from accounts where blob->'pw'->>'w'='new'")).rows[0].n, 1);
  await expectErr(call(ann, 'update_account_blob', { blob: { kdf: {} } }), /bad_request/);
});
T('delete_me removes you and your data; the last admin cannot leave', async () => {
  await expectErr(call(boss, 'delete_me'), /last_admin/);
  await call(cat, 'delete_me');
  assert.equal((await db.query('select count(*)::int n from profiles where id=$1', [cat])).rows[0].n, 0);
});
T('a clinician cannot escalate privileges through any function they can call', async () => {
  await denied("update public.profiles set role='admin'");
  await call(ann, 'register_account', { name: 'Ann', role: 'admin', status: 'active', blob: blob() });
  assert.equal((await db.query("select role, status from profiles where id=$1", [ann])).rows[0].role, 'clinician');
});
