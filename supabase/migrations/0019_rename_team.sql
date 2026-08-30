-- Let an organiser rename either team and a captain rename only their own.
--
-- Teams have no client-side UPDATE policy, so this deliberately narrow RPC is
-- the complete write surface. The event keeps every open player/admin screen
-- in sync without exposing anything private: team names are already readable
-- by every signed-in player.

create or replace function rename_team(p_team_id uuid, p_name text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_game_id  uuid;
  v_old_name text;
  v_new_name text := btrim(p_name);
begin
  if v_new_name is null or v_new_name = '' then
    raise exception 'Team name cannot be empty';
  end if;

  if char_length(v_new_name) > 50 then
    raise exception 'Team name cannot be longer than 50 characters';
  end if;

  select game_id, name into v_game_id, v_old_name
    from teams
   where id = p_team_id;

  if not found then
    raise exception 'Team not found';
  end if;

  if not is_admin() and not exists (
    select 1
      from team_members
     where team_id = p_team_id
       and profile_id = auth.uid()
       and role = 'captain'
  ) then
    raise exception 'Only this team''s captain or an admin may rename it';
  end if;

  if exists (
    select 1
      from teams
     where game_id = v_game_id
       and id <> p_team_id
       and lower(name) = lower(v_new_name)
  ) then
    raise exception 'The two teams need different names';
  end if;

  if v_new_name = v_old_name then
    return v_new_name;
  end if;

  update teams set name = v_new_name where id = p_team_id;

  insert into game_events (game_id, team_id, type, payload)
  values (
    v_game_id,
    p_team_id,
    'team_renamed',
    jsonb_build_object('old_name', v_old_name, 'new_name', v_new_name)
  );

  return v_new_name;
end;
$$;

revoke execute on function rename_team(uuid, text) from public, anon;
grant execute on function rename_team(uuid, text) to authenticated;
