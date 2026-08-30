-- Restore the complete `place_fleet` implementation after 0016 accidentally
-- replaced it with the older, captain-only version from 0002.
--
-- Keep the `fleet_placed` event added by 0016, while restoring the three guards
-- introduced in 0006:
--   * admins may place either fleet;
--   * every cell must be inside the game grid;
--   * different ships may not touch, even diagonally.

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

  select g.* into v_game
    from games g
    join teams t on t.game_id = g.id
   where t.id = p_team_id;

  if not found then
    raise exception 'Team not found';
  end if;

  if v_game.status <> 'placement' then
    raise exception 'Fleet placement is closed (game is %)', v_game.status;
  end if;

  -- Placement is all-or-nothing; a later exception rolls this deletion back.
  delete from ships where team_id = p_team_id;

  for v_ship in select * from jsonb_array_elements(p_ships) loop
    v_cells := v_ship -> 'cells';
    v_size  := jsonb_array_length(v_cells);

    select array_agg((c ->> 'row')::smallint order by (c ->> 'row')::smallint),
           array_agg((c ->> 'col')::smallint order by (c ->> 'col')::smallint)
      into v_rows, v_cols
      from jsonb_array_elements(v_cells) c;

    if v_size <> (v_ship ->> 'size')::int then
      raise exception 'Ship declares size % but supplied % cells',
        v_ship ->> 'size', v_size;
    end if;

    if v_rows[1] < 1 or v_cols[1] < 1
       or v_rows[v_size] > v_game.grid_size
       or v_cols[v_size] > v_game.grid_size then
      raise exception 'Ship falls outside the % x % grid',
        v_game.grid_size, v_game.grid_size;
    end if;

    if v_rows[1] = v_rows[v_size] then
      if v_cols[v_size] - v_cols[1] <> v_size - 1 then
        raise exception 'Horizontal ship at row % is not contiguous', v_rows[1];
      end if;
    elsif v_cols[1] = v_cols[v_size] then
      if v_rows[v_size] - v_rows[1] <> v_size - 1 then
        raise exception 'Vertical ship at column % is not contiguous', v_cols[1];
      end if;
    else
      raise exception 'Ship is neither horizontal nor vertical';
    end if;

    insert into ships (team_id, size)
    values (p_team_id, v_size)
    returning id into v_new_ship_id;

    insert into ship_cells (ship_id, team_id, row, col)
    select v_new_ship_id, p_team_id,
           (c ->> 'row')::smallint, (c ->> 'col')::smallint
      from jsonb_array_elements(v_cells) c;

    v_sizes := v_sizes || v_size::smallint;
  end loop;

  if (select array_agg(x order by x) from unnest(v_sizes) x)
     is distinct from
     (select array_agg(x order by x) from unnest(v_game.fleet) x) then
    raise exception 'Fleet must be sizes %, got %',
      array_to_string(v_game.fleet, ','), array_to_string(v_sizes, ',');
  end if;

  -- Chebyshev distance <= 1 covers both orthogonal and diagonal touching.
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

  -- Last, so a rejected placement emits no event. Cell positions remain secret.
  insert into game_events (game_id, team_id, type, payload)
  values (v_game.id, p_team_id, 'fleet_placed',
          jsonb_build_object('ships', array_length(v_sizes, 1)));
end;
$$;

revoke execute on function place_fleet(uuid, jsonb) from public, anon;
grant execute on function place_fleet(uuid, jsonb) to authenticated;
