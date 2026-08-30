-- HS_Battleships — ship spacing rule + admin role and admin RPCs
--
-- Two changes:
--   1. Ships may not touch, not even diagonally. Classic Battleships spacing.
--   2. An admin role, so running an event no longer means hand-writing SQL.
--
-- It also closes a hole: start_game() had no permission check at all, so any
-- signed-in player could start any game — including one where the other team
-- had not finished placing. It is now admin-only.

-- ============================================================
-- Admin role
-- ============================================================

alter table profiles add column if not exists is_admin boolean not null default false;

-- security definer so it can be called from inside other definer functions
-- without depending on the caller's read access to profiles.
create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select p.is_admin from profiles p where p.id = auth.uid()), false);
$$;

revoke execute on function is_admin() from public, anon;
grant  execute on function is_admin() to authenticated;

-- Admins must not be able to promote themselves or anyone else through the
-- normal self-update policy, or the role would be meaningless.
drop policy if exists profiles_self on profiles;
create policy profiles_self on profiles
  for update using (id = auth.uid()) with check (id = auth.uid() and is_admin = (
    select p.is_admin from profiles p where p.id = auth.uid()
  ));

-- ============================================================
-- 1. Fleet placement — ships may not touch
-- ============================================================
-- Adds the spacing rule to the existing validation, and lets an admin place a
-- fleet on a team's behalf (needed by the admin setup screen).

create or replace function place_fleet(p_team_id uuid, p_ships jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_game        games%rowtype;
  v_ship        jsonb;
  v_cells       jsonb;
  v_rows        smallint[];
  v_cols        smallint[];
  v_size        int;
  v_new_ship_id uuid;
  v_sizes       smallint[] := '{}';
  v_touch       record;
begin
  if not is_admin() and not exists (
    select 1 from team_members
     where team_id = p_team_id and profile_id = auth.uid() and role = 'captain'
  ) then
    raise exception 'Only a team captain or an admin may place the fleet';
  end if;

  select g.* into v_game from games g join teams t on t.game_id = g.id where t.id = p_team_id;

  if v_game.status <> 'placement' then
    raise exception 'Fleet placement is closed (game is %)', v_game.status;
  end if;

  -- Placement is all-or-nothing; wipe any previous attempt.
  delete from ships where team_id = p_team_id;

  for v_ship in select * from jsonb_array_elements(p_ships) loop
    v_cells := v_ship -> 'cells';
    v_size  := jsonb_array_length(v_cells);

    select array_agg((c ->> 'row')::smallint order by (c ->> 'row')::smallint),
           array_agg((c ->> 'col')::smallint order by (c ->> 'col')::smallint)
      into v_rows, v_cols
      from jsonb_array_elements(v_cells) c;

    if v_size <> (v_ship ->> 'size')::int then
      raise exception 'Ship declares size % but supplied % cells', v_ship ->> 'size', v_size;
    end if;

    -- In bounds?
    if v_rows[1] < 1 or v_cols[1] < 1
       or v_rows[v_size] > v_game.grid_size or v_cols[v_size] > v_game.grid_size then
      raise exception 'Ship falls outside the % x % grid', v_game.grid_size, v_game.grid_size;
    end if;

    -- Straight and contiguous: one axis constant, the other a run of consecutive values.
    if v_rows[1] = v_rows[v_size] then                       -- horizontal
      if v_cols[v_size] - v_cols[1] <> v_size - 1 then
        raise exception 'Horizontal ship at row % is not contiguous', v_rows[1];
      end if;
    elsif v_cols[1] = v_cols[v_size] then                    -- vertical
      if v_rows[v_size] - v_rows[1] <> v_size - 1 then
        raise exception 'Vertical ship at column % is not contiguous', v_cols[1];
      end if;
    else
      raise exception 'Ship is neither horizontal nor vertical';
    end if;

    insert into ships (team_id, size) values (p_team_id, v_size) returning id into v_new_ship_id;

    insert into ship_cells (ship_id, team_id, row, col)
    select v_new_ship_id, p_team_id, (c ->> 'row')::smallint, (c ->> 'col')::smallint
      from jsonb_array_elements(v_cells) c;

    v_sizes := v_sizes || v_size::smallint;
  end loop;

  -- Fleet composition must match exactly (default 2,3,3,4,5).
  if (select array_agg(x order by x) from unnest(v_sizes) x)
     is distinct from
     (select array_agg(x order by x) from unnest(v_game.fleet) x) then
    raise exception 'Fleet must be sizes %, got %',
      array_to_string(v_game.fleet, ','), array_to_string(v_sizes, ',');
  end if;

  -- Ships may not touch, not even at the corners. Checked across the whole fleet
  -- at once rather than per ship, so the order they arrive in cannot matter.
  -- Chebyshev distance <= 1 covers orthogonal and diagonal adjacency alike.
  select a.row as arow, a.col as acol, b.row as brow, b.col as bcol
    into v_touch
    from ship_cells a
    join ship_cells b
      on b.team_id = a.team_id
     and b.ship_id <> a.ship_id
     and abs(b.row - a.row) <= 1
     and abs(b.col - a.col) <= 1
   where a.team_id = p_team_id
   limit 1;

  if found then
    raise exception 'Ships may not touch, not even at the corners (r%c% touches r%c%)',
      v_touch.arow, v_touch.acol, v_touch.brow, v_touch.bcol;
  end if;
end;
$$;

-- ============================================================
-- 2. start_game — admin only, and the board must be complete
-- ============================================================

create or replace function start_game(p_game_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_game    games%rowtype;
  v_teams   int;
  v_unready int;
  v_tiles   int;
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

  -- A short board would make some tiles unreachable, so check it here rather
  -- than discovering it mid-event.
  select count(*) into v_tiles from tiles where game_id = p_game_id;
  if v_tiles <> v_game.grid_size * v_game.grid_size then
    raise exception 'Game needs % tiles before it can start (has %)',
      v_game.grid_size * v_game.grid_size, v_tiles;
  end if;

  select count(*) into v_unready
    from teams t
   where t.game_id = p_game_id
     and (select count(*) from ships s where s.team_id = t.id)
         <> array_length(v_game.fleet, 1);

  if v_unready > 0 then
    raise exception '% team(s) have not finished placing their fleet', v_unready;
  end if;

  update games set status = 'active', started_at = now() where id = p_game_id;

  insert into game_events (game_id, type, payload)
  values (p_game_id, 'game_started', jsonb_build_object('by', auth.uid()));
end;
$$;

-- ============================================================
-- 3. Admin RPCs
-- ============================================================

-- Create a game and both its teams in one transaction.
create or replace function admin_create_game(
  p_name text, p_team_a text, p_team_b text,
  p_grid_size smallint default 10, p_max_active smallint default 2
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_game_id uuid;
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if btrim(coalesce(p_name,''))   = '' then raise exception 'Game needs a name'; end if;
  if btrim(coalesce(p_team_a,'')) = '' or btrim(coalesce(p_team_b,'')) = '' then
    raise exception 'Both teams need a name';
  end if;
  if btrim(p_team_a) = btrim(p_team_b) then
    raise exception 'The two teams need different names';
  end if;

  insert into games (name, status, grid_size, max_active_tiles)
  values (btrim(p_name), 'setup', p_grid_size, p_max_active)
  returning id into v_game_id;

  insert into teams (game_id, name) values (v_game_id, btrim(p_team_a)), (v_game_id, btrim(p_team_b));

  return v_game_id;
end;
$$;

-- Replace a game's tile grid. p_tiles: [{"row":1,"col":1,"name":"...","rules":"..."}, ...]
-- Refused once the game is active so tasks cannot change under a claimed tile.
create or replace function admin_set_tiles(p_game_id uuid, p_tiles jsonb)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_game  games%rowtype;
  v_count int;
begin
  if not is_admin() then raise exception 'Admins only'; end if;

  select * into v_game from games where id = p_game_id;
  if not found then raise exception 'No such game'; end if;
  if v_game.status not in ('setup', 'placement') then
    raise exception 'Tiles are locked once the game is % ', v_game.status;
  end if;

  v_count := jsonb_array_length(p_tiles);
  if v_count <> v_game.grid_size * v_game.grid_size then
    raise exception 'Expected % tiles, got %', v_game.grid_size * v_game.grid_size, v_count;
  end if;

  delete from tiles where game_id = p_game_id;

  insert into tiles (game_id, row, col, name, rules)
  select p_game_id,
         (t ->> 'row')::smallint,
         (t ->> 'col')::smallint,
         coalesce(nullif(btrim(t ->> 'name'), ''), 'Tile'),
         nullif(btrim(coalesce(t ->> 'rules', '')), '')
    from jsonb_array_elements(p_tiles) t;

  return v_count;
end;
$$;

-- Put a player on a team (or change their role). One team per game per player.
create or replace function admin_set_member(p_team_id uuid, p_profile_id uuid, p_role team_role)
returns void
language plpgsql security definer set search_path = public as $$
declare v_game_id uuid;
begin
  if not is_admin() then raise exception 'Admins only'; end if;

  select game_id into v_game_id from teams where id = p_team_id;
  if not found then raise exception 'No such team'; end if;

  -- Drop any seat they already hold in this game, so switching sides is one call
  -- and nobody can end up on both teams.
  delete from team_members tm
   using teams t
   where tm.team_id = t.id and t.game_id = v_game_id and tm.profile_id = p_profile_id;

  insert into team_members (team_id, profile_id, role) values (p_team_id, p_profile_id, p_role);
end;
$$;

create or replace function admin_remove_member(p_team_id uuid, p_profile_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  delete from team_members where team_id = p_team_id and profile_id = p_profile_id;
end;
$$;

-- setup -> placement, so captains (or the admin) can start placing fleets.
create or replace function admin_open_placement(p_game_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_status game_status;
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  select status into v_status from games where id = p_game_id;
  if v_status <> 'setup' then
    raise exception 'Game is already % ', v_status;
  end if;
  update games set status = 'placement' where id = p_game_id;
end;
$$;

-- The admin screens need to see what players must not: every tile's task, and
-- both fleets. RLS denies both, so these are the deliberate, admin-gated windows.
-- "row" and "position" are reserved in a RETURNS TABLE column list, so they are
-- quoted here. The quoting only affects this signature; callers still see the
-- plain column names.
create or replace function admin_list_tiles(p_game_id uuid)
returns table (id uuid, "row" smallint, col smallint, "position" smallint, name text, rules text)
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  return query
    select t.id, t.row, t.col, t.position, t.name, t.rules
      from tiles t where t.game_id = p_game_id order by t.position;
end;
$$;

create or replace function admin_list_ship_cells(p_game_id uuid)
returns table (team_id uuid, ship_id uuid, size smallint, "row" smallint, col smallint)
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  return query
    select s.team_id, s.id, s.size, sc.row, sc.col
      from ships s
      join teams t on t.id = s.team_id
      join ship_cells sc on sc.ship_id = s.id
     where t.game_id = p_game_id;
end;
$$;

create or replace function admin_delete_game(p_game_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  delete from games where id = p_game_id;   -- cascades to teams, tiles, claims, events
end;
$$;

-- Only signed-in admins; the check inside each function is the real gate, but
-- an unauthenticated caller should not even reach it.
revoke execute on function admin_create_game(text, text, text, smallint, smallint) from public, anon;
revoke execute on function admin_set_tiles(uuid, jsonb)                            from public, anon;
revoke execute on function admin_set_member(uuid, uuid, team_role)                 from public, anon;
revoke execute on function admin_remove_member(uuid, uuid)                         from public, anon;
revoke execute on function admin_open_placement(uuid)                              from public, anon;
revoke execute on function admin_list_tiles(uuid)                                  from public, anon;
revoke execute on function admin_list_ship_cells(uuid)                             from public, anon;
revoke execute on function admin_delete_game(uuid)                                 from public, anon;

grant execute on function admin_create_game(text, text, text, smallint, smallint) to authenticated;
grant execute on function admin_set_tiles(uuid, jsonb)                            to authenticated;
grant execute on function admin_set_member(uuid, uuid, team_role)                 to authenticated;
grant execute on function admin_remove_member(uuid, uuid)                         to authenticated;
grant execute on function admin_open_placement(uuid)                              to authenticated;
grant execute on function admin_list_tiles(uuid)                                  to authenticated;
grant execute on function admin_list_ship_cells(uuid)                             to authenticated;
grant execute on function admin_delete_game(uuid)                                 to authenticated;
