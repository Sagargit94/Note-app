-- =====================================================================================================
-- PhysioNotes clinic backend for Supabase (free tier).
-- How to use: Supabase dashboard -> SQL Editor -> New query -> paste this whole file -> edit the ONE
-- marked line below -> Run. Safe to run again later (it updates functions without touching your data).
--
-- Design:
--  * Patient data is end-to-end encrypted IN THE BROWSER. This database only ever stores ciphertext,
--    plus a small directory (name, email, role, status) so an administrator can approve and disable people.
--  * The tables have Row Level Security switched on with NO policies, so the public API can't touch them
--    directly. The app talks only to the checked functions below (each one verifies who you are and that
--    your account is "active"). Anonymous visitors can call exactly one function (kdf_params).
-- =====================================================================================================

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.config (key text primary key, value text not null);

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text not null unique,
  display_name text not null,
  role         text not null default 'clinician' check (role in ('admin', 'clinician')),
  status       text not null default 'pending'   check (status in ('pending', 'active', 'disabled')),
  created_at   timestamptz not null default now(),
  approved_at  timestamptz,
  last_seen    timestamptz
);

-- Public key material only: salts and the data key wrapped by the user's password / recovery key.
create table if not exists public.accounts (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  blob       jsonb not null,
  updated_at timestamptz not null default now()
);

create sequence if not exists public.record_seq;
create table if not exists public.records (
  user_id    uuid   not null references public.profiles (id) on delete cascade,
  kind       text   not null check (kind in ('p', 'v', 'a', 's')),
  id         text   not null check (id ~ '^[A-Za-z0-9_-]{1,64}$'),
  body       text,                         -- encrypted record (JSON of ciphertext); null once deleted
  deleted    boolean not null default false,
  seq        bigint not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, id)
);
create index if not exists records_user_seq on public.records (user_id, seq);

create table if not exists public.audit_log (
  id     bigserial primary key,
  at     timestamptz not null default now(),
  actor  uuid,
  action text not null,
  target uuid,
  detail jsonb
);

alter table public.profiles  enable row level security;
alter table public.accounts  enable row level security;
alter table public.records   enable row level security;
alter table public.audit_log enable row level security;
revoke all on public.profiles, public.accounts, public.records, public.audit_log from anon, authenticated;
revoke all on sequence public.record_seq, public.audit_log_id_seq from anon, authenticated;

-- ---- STEP 1: the administrator's email (the first person to sign up with it becomes the admin) --------
do $setup$
declare
  v_admin_email constant text := 'EDIT-ME@example.com';      -- <<<<<<<<<< EDIT THIS LINE
begin
  if v_admin_email = 'EDIT-ME@example.com' then
    raise exception 'Please replace EDIT-ME@example.com with the administrator''s email address, then run again.';
  end if;
  insert into private.config (key, value) values ('admin_email', lower(trim(v_admin_email)))
    on conflict (key) do update set value = excluded.value;
  insert into private.config (key, value)
    values ('salt_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
    on conflict (key) do nothing;
end
$setup$;

-- ---- helpers (not reachable from the API) ---------------------------------------------------------------
create or replace function private.require_active() returns public.profiles
language plpgsql security definer set search_path = '' as $$
declare p public.profiles;
begin
  select * into p from public.profiles where id = auth.uid();
  if p.id is null or p.status <> 'active' then raise exception 'not_active'; end if;
  return p;
end $$;

create or replace function private.require_admin() returns public.profiles
language plpgsql security definer set search_path = '' as $$
declare p public.profiles;
begin
  p := private.require_active();
  if p.role <> 'admin' then raise exception 'not_admin'; end if;
  return p;
end $$;

create or replace function private.valid_blob(b jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select b is not null and jsonb_typeof(b) = 'object' and length(b::text) < 6000
     and b #>> '{kdf,salt}' is not null and b #>> '{pw,w}' is not null and b #>> '{rec,w}' is not null
$$;

-- ---- public API (called by the app) -----------------------------------------------------------------------

-- Anonymous: returns the password-hashing salt for an email, so a NEW device can derive its keys.
-- Unknown emails get a stable fake salt so this can't be used to discover who has an account.
create or replace function public.kdf_params(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_email text := lower(trim(coalesce(p ->> 'email', ''))); v_kdf jsonb; v_secret text;
begin
  if v_email = '' or length(v_email) > 254 then raise exception 'bad_request'; end if;
  select a.blob -> 'kdf' into v_kdf from public.accounts a join public.profiles pr on pr.id = a.user_id where pr.email = v_email;
  if v_kdf is not null then return v_kdf; end if;
  select value into v_secret from private.config where key = 'salt_secret';
  return jsonb_build_object('salt', encode(substring(sha256(convert_to(v_secret || ':' || v_email, 'UTF8')) from 1 for 16), 'base64'), 'iter', 600000);
end $$;

-- Called right after sign-up. Everyone starts "pending" except the configured administrator.
create or replace function public.register_account(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); v_email text; v_name text := left(trim(coalesce(p ->> 'name', '')), 100);
  v_blob jsonb := p -> 'blob'; v_admin text; v_role text := 'clinician'; v_status text := 'pending'; v_prof public.profiles;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  select * into v_prof from public.profiles where id = v_uid;
  if found then return jsonb_build_object('status', v_prof.status, 'role', v_prof.role); end if;   -- idempotent
  select lower(email) into v_email from auth.users where id = v_uid;
  if v_email is null or v_name = '' or not private.valid_blob(v_blob) then raise exception 'bad_request'; end if;
  select value into v_admin from private.config where key = 'admin_email';
  if v_email = v_admin and not exists (select 1 from public.profiles where role = 'admin') then v_role := 'admin'; v_status := 'active'; end if;
  insert into public.profiles (id, email, display_name, role, status, approved_at)
    values (v_uid, v_email, v_name, v_role, v_status, case when v_status = 'active' then now() end);
  insert into public.accounts (user_id, blob) values (v_uid, v_blob);
  insert into public.audit_log (actor, action, target, detail)
    values (v_uid, 'register', v_uid, jsonb_build_object('email', v_email, 'role', v_role, 'status', v_status));
  return jsonb_build_object('status', v_status, 'role', v_role);
end $$;

-- Who am I, and am I allowed in? (The key blob is only released to active accounts.)
create or replace function public.my_profile(p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_p public.profiles; v_blob jsonb; v_pending int := null;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  select * into v_p from public.profiles where id = v_uid;
  if not found then return jsonb_build_object('status', 'unregistered'); end if;
  if v_p.status = 'active' then
    select blob into v_blob from public.accounts where user_id = v_uid;
    if v_p.last_seen is null or v_p.last_seen < now() - interval '1 minute' then update public.profiles set last_seen = now() where id = v_uid; end if;
    if v_p.role = 'admin' then select count(*) into v_pending from public.profiles where status = 'pending'; end if;
  end if;
  return jsonb_build_object('id', v_p.id, 'email', v_p.email, 'name', v_p.display_name, 'role', v_p.role, 'status', v_p.status,
                            'blob', v_blob, 'pending_count', v_pending);
end $$;

create or replace function public.update_account_blob(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_p public.profiles := private.require_active();
begin
  if not private.valid_blob(p -> 'blob') then raise exception 'bad_request'; end if;
  update public.accounts set blob = p -> 'blob', updated_at = now() where user_id = v_p.id;
  insert into public.audit_log (actor, action, target, detail) values (v_p.id, 'account_key_update', v_p.id, jsonb_build_object('email', v_p.email));
  return jsonb_build_object('ok', true);
end $$;

-- ---- encrypted record sync (every function is scoped to the caller's own rows) ----------------------------
create or replace function public.sync_changes(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_p public.profiles := private.require_active(); v_since bigint := coalesce((p ->> 'since')::bigint, 0);
        v_deleted boolean := coalesce((p ->> 'deleted')::boolean, true); v_items jsonb; v_last bigint; v_more boolean;
begin
  select coalesce(jsonb_agg(jsonb_build_object('k', kind, 'id', id, 'seq', seq, 'd', deleted) order by seq), '[]'::jsonb)
    into v_items
    from (select kind, id, seq, deleted from public.records
           where user_id = v_p.id and seq > v_since and (v_deleted or not deleted) order by seq limit 2000) s;
  v_last := coalesce((v_items -> -1 ->> 'seq')::bigint, v_since);
  select exists (select 1 from public.records where user_id = v_p.id and seq > v_last and (v_deleted or not deleted)) into v_more;
  return jsonb_build_object('items', v_items, 'more', v_more);
end $$;

create or replace function public.sync_get(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_p public.profiles := private.require_active(); r public.records;
begin
  select * into r from public.records where user_id = v_p.id and kind = p ->> 'k' and id = p ->> 'id' and not deleted;
  if not found then return 'null'::jsonb; end if;
  return jsonb_build_object('body', r.body, 'seq', r.seq);
end $$;

-- base: null  -> create only (fails if a live record exists);  number -> update only if the record is still at that seq
create or replace function public.sync_put(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_p public.profiles := private.require_active(); v_k text := p ->> 'k'; v_id text := p ->> 'id'; v_body text := p ->> 'body';
        v_row public.records; v_seq bigint; v_ok boolean;
begin
  if v_k not in ('p', 'v', 'a', 's') or v_id !~ '^[A-Za-z0-9_-]{1,64}$' or v_body is null or length(v_body) > 20000000 then raise exception 'bad_request'; end if;
  select * into v_row from public.records where user_id = v_p.id and kind = v_k and id = v_id for update;
  if jsonb_typeof(p -> 'base') = 'number' then v_ok := found and not v_row.deleted and v_row.seq = (p ->> 'base')::bigint;
  else v_ok := not found or v_row.deleted; end if;
  if not v_ok then return jsonb_build_object('ok', false, 'reason', 'conflict'); end if;
  v_seq := nextval('public.record_seq');
  insert into public.records (user_id, kind, id, body, deleted, seq) values (v_p.id, v_k, v_id, v_body, false, v_seq)
    on conflict (user_id, kind, id) do update set body = excluded.body, deleted = false, seq = excluded.seq, updated_at = now();
  return jsonb_build_object('ok', true, 'seq', v_seq);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'reason', 'conflict');
end $$;

create or replace function public.sync_delete(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_p public.profiles := private.require_active();
begin
  update public.records set deleted = true, body = null, seq = nextval('public.record_seq'), updated_at = now()
   where user_id = v_p.id and kind = p ->> 'k' and id = p ->> 'id' and not deleted;
  return jsonb_build_object('ok', true);
end $$;

-- ---- account self-service ----------------------------------------------------------------------------------
create or replace function public.delete_me(p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_p public.profiles;
begin
  select * into v_p from public.profiles where id = auth.uid();
  if not found then raise exception 'not_registered'; end if;
  if v_p.role = 'admin' and not exists (select 1 from public.profiles where role = 'admin' and status = 'active' and id <> v_p.id) then
    raise exception 'last_admin';
  end if;
  insert into public.audit_log (actor, action, target, detail) values (v_p.id, 'delete_self', v_p.id, jsonb_build_object('email', v_p.email));
  delete from auth.users where id = v_p.id;            -- cascades to profile, account and all encrypted records
  return jsonb_build_object('ok', true);
end $$;

-- ---- administrator functions (names, emails and status only -- never patient data) ----------------------
create or replace function public.admin_directory(p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_p public.profiles := private.require_admin(); v_out jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('id', pr.id, 'email', pr.email, 'name', pr.display_name, 'role', pr.role, 'status', pr.status,
           'created_at', pr.created_at, 'approved_at', pr.approved_at, 'last_seen', pr.last_seen,
           'records', coalesce(u.n, 0), 'bytes', coalesce(u.b, 0))
         order by (pr.status = 'pending') desc, (pr.status = 'disabled'), pr.created_at), '[]'::jsonb)
    into v_out
    from public.profiles pr
    left join (select user_id, count(*) filter (where not deleted) n, sum(coalesce(length(body), 0)) b from public.records group by user_id) u on u.user_id = pr.id;
  return v_out;
end $$;

create or replace function public.admin_set_status(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_a public.profiles := private.require_admin(); v_t public.profiles; v_status text := p ->> 'status';
begin
  if v_status not in ('active', 'disabled') then raise exception 'bad_request'; end if;
  select * into v_t from public.profiles where id = (p ->> 'user')::uuid;
  if not found then raise exception 'not_found'; end if;
  if v_t.id = v_a.id then raise exception 'cannot_change_self'; end if;
  update public.profiles set status = v_status, approved_at = coalesce(approved_at, case when v_status = 'active' then now() end) where id = v_t.id;
  -- also stop the sign-in service from issuing new sessions to a disabled person
  update auth.users set banned_until = case when v_status = 'disabled' then 'infinity'::timestamptz else null end where id = v_t.id;
  insert into public.audit_log (actor, action, target, detail)
    values (v_a.id, case when v_status = 'disabled' then 'disable' when v_t.status = 'pending' then 'approve' else 'enable' end, v_t.id,
            jsonb_build_object('actor_email', v_a.email, 'target_email', v_t.email));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_set_role(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_a public.profiles := private.require_admin(); v_t public.profiles; v_role text := p ->> 'role';
begin
  if v_role not in ('admin', 'clinician') then raise exception 'bad_request'; end if;
  select * into v_t from public.profiles where id = (p ->> 'user')::uuid;
  if not found then raise exception 'not_found'; end if;
  if v_t.id = v_a.id then raise exception 'cannot_change_self'; end if;
  update public.profiles set role = v_role where id = v_t.id;
  insert into public.audit_log (actor, action, target, detail)
    values (v_a.id, 'set_role', v_t.id, jsonb_build_object('actor_email', v_a.email, 'target_email', v_t.email, 'role', v_role));
  return jsonb_build_object('ok', true);
end $$;

-- Permanently removes a PENDING or DISABLED person together with their encrypted cloud copy.
create or replace function public.admin_remove_user(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_a public.profiles := private.require_admin(); v_t public.profiles;
begin
  select * into v_t from public.profiles where id = (p ->> 'user')::uuid;
  if not found then raise exception 'not_found'; end if;
  if v_t.id = v_a.id then raise exception 'cannot_change_self'; end if;
  if v_t.status = 'active' then raise exception 'disable_first'; end if;
  insert into public.audit_log (actor, action, target, detail)
    values (v_a.id, 'remove', v_t.id, jsonb_build_object('actor_email', v_a.email, 'target_email', v_t.email));
  delete from auth.users where id = v_t.id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_audit(p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_p public.profiles := private.require_admin(); v_out jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('at', at, 'action', action, 'detail', detail) order by id desc), '[]'::jsonb)
    into v_out from (select * from public.audit_log order by id desc limit 100) a;
  return v_out;
end $$;

-- ---- permissions: nothing is callable by default; grant exactly what each caller type needs ---------------
do $grants$
declare f text;
begin
  foreach f in array array[
    'kdf_params(jsonb)', 'register_account(jsonb)', 'my_profile(jsonb)', 'update_account_blob(jsonb)', 'sync_changes(jsonb)', 'sync_get(jsonb)',
    'sync_put(jsonb)', 'sync_delete(jsonb)', 'delete_me(jsonb)', 'admin_directory(jsonb)', 'admin_set_status(jsonb)', 'admin_set_role(jsonb)',
    'admin_remove_user(jsonb)', 'admin_audit(jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  grant execute on function public.kdf_params(jsonb) to anon;
end
$grants$;
