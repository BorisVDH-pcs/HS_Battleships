-- Both teams need a captain before a game can start.
--
-- Nothing required one until now. `start_game` checked two teams, the full tile
-- count and two complete fleets, and `admin_open_placement` checked only the
-- status -- so a game could reach `active` with a team that had no captain.
--
-- That state is a silent dead end rather than a loud failure, which is why it
-- went unnoticed. `place_fleet` accepts a captain or an admin (0006), and
-- CaptainPlacement only renders the placer for `myRole === 'captain'`. A team
-- with no captain therefore has no member who can place its fleet and no
-- message saying so -- the organiser has to notice and place it by hand.
--
-- An admin can still place either fleet, deliberately: that is the escape hatch
-- when a captain is unreachable on the night. What changes is that the gap can
-- no longer go unnoticed until someone is staring at a board they cannot use.
--
-- Same shape as the guards around it: counted, compared, and refused with a
-- message that names the teams at fault rather than a number to go and look up.

create or replace function start_game(p_game_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_game      games%rowtype;
  v_teams     int;
  v_unready   int;
  v_tiles     int;
  v_no_captain text;
begin
  if not is_admin() then
    raise exception 'Only an admin may start the game';
  end if;

  select * into v_game from games where id = p_game_id;

  if v_game.status <> 'placement' then
    raise exception 'Game is % — it can only be started from placement', v_game.status;
  end if;

  select count(*) into v_teams from teams where game_id = p_game_id;
  if v_teams <> 2 then
    raise exception 'Game needs two teams before it can start (has %)', v_teams;
  end if;

  select count(*) into v_tiles from tiles where game_id = p_game_id;
  if v_tiles <> v_game.grid_size * v_game.grid_size then
    raise exception 'Game needs % tiles before it can start (has %)',
      v_game.grid_size * v_game.grid_size, v_tiles;
  end if;

  -- Named, not counted: "1 team has no captain" sends the organiser hunting
  -- through the roster, and the roster is the one screen that cannot show it.
  select string_agg(t.name, ' and ' order by t.name) into v_no_captain
    from teams t
   where t.game_id = p_game_id
     and not exists (
       select 1 from team_members m
        where m.team_id = t.id and m.role = 'captain'
     );

  if v_no_captain is not null then
    raise exception
      '% needs a captain before the game can start — set one in the roster',
      v_no_captain;
  end if;

  select count(*) into v_unready
    from teams t
   where t.game_id = p_game_id
     and (select count(*) from ships s where s.team_id = t.id)
         <> array_length(v_game.fleet, 1);

  if v_unready > 0 then
    raise exception '% team(s) have not finished placing their fleet', v_unready;
  end if;

  -- Cheap, and the last moment anyone is looking at the board before it counts.
  perform assert_fleets_consistent(p_game_id);

  update games set status = 'active', started_at = now() where id = p_game_id;

  insert into game_events (game_id, type, payload)
  values (p_game_id, 'game_started', jsonb_build_object('by', auth.uid()));
end;
$$;

revoke execute on function start_game(uuid) from public, anon;
grant  execute on function start_game(uuid) to authenticated;
