-- Log every account deletion, same shape as admin_password_resets (0913180000)
-- so the Accounts screen can show one merged activity feed. A separate table
-- rather than reusing that one: a deleted account's own id is gone by the time
-- this would be read back, so there is no target_id to carry, only the name.
create table if not exists admin_account_deletions (
  id                   uuid        primary key default gen_random_uuid(),
  admin_id             uuid        references profiles(id) on delete set null,
  target_display_name  text        not null,
  created_at           timestamptz not null default now()
);

alter table admin_account_deletions enable row level security;

create or replace function admin_list_account_deletions(p_limit int default 20)
returns table (
  id uuid,
  target_display_name text,
  admin_display_name text,
  created_at timestamptz
)
language sql security definer set search_path = public as $$
  select d.id, d.target_display_name, p.display_name, d.created_at
  from admin_account_deletions d
  left join profiles p on p.id = d.admin_id
  where is_admin()
  order by d.created_at desc
  limit p_limit;
$$;

revoke execute on function admin_list_account_deletions(int) from public, anon;
grant  execute on function admin_list_account_deletions(int) to authenticated;

-- Record the deletion, but only once it actually happens — a refused attempt
-- (admin account, or real pet-jar activity) should leave no trace here.
create or replace function admin_delete_account(p_profile_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_is_admin boolean;
begin
  if not is_admin() then raise exception 'Admins only'; end if;

  select display_name, is_admin into v_name, v_is_admin
  from profiles where id = p_profile_id;
  if v_name is null then raise exception 'Player not found'; end if;
  if v_is_admin then raise exception 'Cannot delete an admin account'; end if;

  begin
    delete from auth.users where id = p_profile_id;
  exception when foreign_key_violation then
    raise exception 'Cannot delete %: they have game activity (pet jar) on record', v_name;
  end;

  insert into admin_account_deletions (admin_id, target_display_name)
  values (auth.uid(), v_name);
end;
$$;

revoke execute on function admin_delete_account(uuid) from public, anon;
grant  execute on function admin_delete_account(uuid) to authenticated;
