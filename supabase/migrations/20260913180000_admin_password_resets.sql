-- Admin-only password reset, plus a log of who reset what.
--
-- Before this, resetting a player's password meant opening the Supabase SQL
-- editor by hand (see supabase/admin/player-accounts.sql) -- a deliberate
-- choice to keep that capability outside the app entirely. It stays
-- admin-only and uses the exact same mechanism as that manual snippet
-- (pgcrypto's crypt()/gen_salt(), not the service-role Admin API), so nothing
-- new is exposed to the browser -- only where the capability is reachable
-- from changes.
--
-- The log exists because there is exactly one admin account and it is never
-- shared, so "which admin did it" is not the question -- "did I actually do
-- this, and when" is. target_display_name is a snapshot, not a live join, so
-- the log still reads correctly if the account is later renamed or removed.

create table if not exists admin_password_resets (
  id                 uuid primary key default gen_random_uuid(),
  admin_id           uuid references profiles(id) on delete set null,
  target_id          uuid references profiles(id) on delete set null,
  target_display_name text not null,
  created_at         timestamptz not null default now()
);

alter table admin_password_resets enable row level security;
-- No policies: reachable only through the security definer functions below,
-- the same lockdown as discord_webhooks.

create or replace function admin_reset_password(p_profile_id uuid, p_new_password text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_target_name text;
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if length(p_new_password) < 8 then
    raise exception 'Password must be at least 8 characters';
  end if;

  select display_name into v_target_name from profiles where id = p_profile_id;
  if v_target_name is null then raise exception 'Player not found'; end if;

  update auth.users
     set encrypted_password = crypt(p_new_password, gen_salt('bf'))
   where id = p_profile_id;

  insert into admin_password_resets (admin_id, target_id, target_display_name)
  values (auth.uid(), p_profile_id, v_target_name);
end;
$$;

revoke execute on function admin_reset_password(uuid, text) from public, anon;
grant  execute on function admin_reset_password(uuid, text) to authenticated;

create or replace function admin_list_password_resets(p_limit int default 20)
returns table (
  id uuid,
  target_display_name text,
  admin_display_name text,
  created_at timestamptz
)
language sql security definer set search_path = public as $$
  select r.id, r.target_display_name, p.display_name, r.created_at
  from admin_password_resets r
  left join profiles p on p.id = r.admin_id
  where is_admin()
  order by r.created_at desc
  limit p_limit;
$$;

revoke execute on function admin_list_password_resets(int) from public, anon;
grant  execute on function admin_list_password_resets(int) to authenticated;
