-- Let an admin remove a player's account outright — for trolls who sign up
-- just to leave junk in the roster. Deleting auth.users cascades to profiles
-- (0001), team_members and locked-in tiles' claimed_by/fired_by (set null),
-- evidence/library/board-preset created_by (set null), and this account's own
-- rows in admin_password_resets (set null). pet_jar_submissions.submitted_by
-- and pet_jar_previews.spent_by have no on-delete action, so a player who has
-- actually taken part in a game is refused rather than silently orphaned.
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
end;
$$;

revoke execute on function admin_delete_account(uuid) from public, anon;
grant  execute on function admin_delete_account(uuid) to authenticated;
