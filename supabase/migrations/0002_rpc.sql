-- HS_Battleships — game logic RPCs
--
-- Every mutation lives here as a `security definer` function. Clients have no
-- direct INSERT/UPDATE rights, so the two secrets (tile answers, enemy ship
-- placement) are never exposed and cannot be bypassed by a crafted request.

-- ============================================================
-- Fleet placement
-- ============================================================
-- The web UI knows which cells belong to which ship, so — unlike the Sheets
-- version — we do not need a flood-fill to *discover* ships. We only need to
-- VALIDATE what was submitted: right sizes, straight, contiguous, in bounds.
-- (Cell overlap is caught by the unique(team_id,row,col) constraint.)
--
-- p_ships: [{"size":3,"cells":[{"row":1,"col":2},...]}, ...]

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
end;
$$;

-- ============================================================
-- Unlock a tile (the trivia gate)
-- ============================================================
-- Fuzzy match ported from the Apps Script: Levenshtein distance, tolerance 1 for
-- short answers and 2 for longer ones. The answer never leaves the server.

create or replace function unlock_tile(p_tile_id uuid, p_answer text)
returns tile_claims
language plpgsql security definer set search_path = public as $$
declare
  v_team_id uuid;
  v_tile    tiles%rowtype;
  v_variant text;
  v_ok      boolean := false;
  v_claim   tile_claims;
begin
  select t.id into v_team_id
    from teams t
    join tiles ti on ti.game_id = t.game_id
    join team_members tm on tm.team_id = t.id
   where ti.id = p_tile_id and tm.profile_id = auth.uid();

  if v_team_id is null then
    raise exception 'You are not a member of a team in this game';
  end if;

  if (select status from games g join teams t on t.game_id = g.id where t.id = v_team_id) <> 'active' then
    raise exception 'The game is not active';
  end if;

  select * into v_tile from tiles where id = p_tile_id;

  foreach v_variant in array v_tile.answer_variants loop
    if levenshtein(lower(trim(p_answer)), lower(trim(v_variant)))
       <= (case when length(v_variant) <= 5 then 1 else 2 end) then
      v_ok := true;
      exit;
    end if;
  end loop;

  if not v_ok then
    raise exception 'Wrong answer';
  end if;

  insert into tile_claims (team_id, tile_id, unlocked_by)
  values (v_team_id, p_tile_id, auth.uid())
  returning * into v_claim;

  insert into game_events (game_id, team_id, type, payload)
  values (v_tile.game_id, v_team_id, 'tile_unlocked',
          jsonb_build_object('tile_id', v_tile.id, 'tile_name', v_tile.name,
                             'position', v_tile.position, 'by', auth.uid()));

  return v_claim;
end;
$$;

-- ============================================================
-- Fire (complete the tile task)
-- ============================================================
-- Resolves HIT/MISS synchronously and returns it. This is what replaces the
-- 120-second polling loop in the Apps Script.

create or replace function fire_tile(p_claim_id uuid)
returns shot_result
language plpgsql security definer set search_path = public as $$
declare
  v_claim    tile_claims%rowtype;
  v_tile     tiles%rowtype;
  v_game_id  uuid;
  v_enemy_id uuid;
  v_result   shot_result;
  v_ship_id  uuid;
begin
  select * into v_claim from tile_claims where id = p_claim_id;

  if v_claim is null then
    raise exception 'No such tile claim';
  end if;
  if v_claim.status = 'fired' then
    raise exception 'That tile has already been fired';
  end if;
  if not exists (select 1 from team_members
                  where team_id = v_claim.team_id and profile_id = auth.uid()) then
    raise exception 'That tile belongs to the other team';
  end if;

  select * into v_tile from tiles where id = v_claim.tile_id;
  v_game_id := v_tile.game_id;

  select id into v_enemy_id from teams
   where game_id = v_game_id and id <> v_claim.team_id;

  -- HIT if the enemy has a ship cell at this tile's coordinate.
  select sc.ship_id into v_ship_id
    from ship_cells sc
   where sc.team_id = v_enemy_id and sc.row = v_tile.row and sc.col = v_tile.col;

  v_result := case when v_ship_id is null then 'miss' else 'hit' end;

  update tile_claims
     set status = 'fired', result = v_result, fired_by = auth.uid(), fired_at = now()
   where id = p_claim_id;

  insert into game_events (game_id, team_id, type, payload)
  values (v_game_id, v_claim.team_id, 'shot_fired',
          jsonb_build_object('tile_id', v_tile.id, 'tile_name', v_tile.name,
                             'position', v_tile.position, 'result', v_result,
                             'by', auth.uid()));

  -- Ship sunk? Derived, so it cannot drift out of sync.
  if v_result = 'hit' and (select sunk from ship_status where ship_id = v_ship_id) then
    insert into game_events (game_id, team_id, type, payload)
    values (v_game_id, v_claim.team_id, 'ship_sunk',
            jsonb_build_object('ship_id', v_ship_id,
                               'size', (select size from ships where id = v_ship_id),
                               'victim_team_id', v_enemy_id));

    -- Fleet wiped out ⇒ game over.
    if not exists (select 1 from ship_status where team_id = v_enemy_id and not sunk) then
      update games set status = 'finished', winner_team_id = v_claim.team_id, ended_at = now()
       where id = v_game_id;

      insert into game_events (game_id, team_id, type, payload)
      values (v_game_id, v_claim.team_id, 'game_won',
              jsonb_build_object('loser_team_id', v_enemy_id));
    end if;
  end if;

  return v_result;
end;
$$;

grant execute on function place_fleet(uuid, jsonb)  to authenticated;
grant execute on function unlock_tile(uuid, text)   to authenticated;
grant execute on function fire_tile(uuid)           to authenticated;
