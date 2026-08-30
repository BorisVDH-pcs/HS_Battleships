-- Make `place_fleet` announce itself.
--
-- It wrote `ships` and `ship_cells` and nothing else, and the admin console
-- only refetches when a `game_events` row appears for the game. So a captain
-- could place a full fleet and the organiser's screen would sit there showing
-- "No fleet placed yet" indefinitely — not a stale cache that ages out, but no
-- signal at all. Found the hard way: a fleet placed on one machine never
-- appeared on the admin's.
--
-- SECURITY: `game_events` is world-readable, so this payload carries no cell
-- positions — that is secret #1. Only the hull count, which is already public
-- in `games.fleet`. "The enemy has finished placing" is not a secret either:
-- `start_game` refuses until both fleets are down, so it becomes obvious the
-- moment the game starts.
--
-- Fires on every save, including a captain repositioning. That is deliberate —
-- the feed is append-only and the admin wants to see the latest state, so the
-- wording reads correctly when it repeats.

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
begin
  if not exists (
    select 1 from team_members
     where team_id = p_team_id and profile_id = auth.uid() and role = 'captain'
  ) then
    raise exception 'Only a team captain may place the fleet';
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

  -- Last, so a rejected placement announces nothing.
  insert into game_events (game_id, team_id, type, payload)
  values (v_game.id, p_team_id, 'fleet_placed',
          jsonb_build_object('ships', array_length(v_sizes, 1)));
end;
$$;
