-- Auto-reveal the ring around a ship the instant it sinks.
--
-- Battleship rule: ships may never touch, not even at a corner (`blockedCells`
-- in board.js already encodes this for placement). So once every cell of a
-- hull is hit, the eight neighbours of each of its cells are guaranteed to
-- hold no ship at all -- the shooting team does not need to spend a claim to
-- learn that, the rule already tells them.
--
-- `fire_tile` is the one place a sinking is detected, so this is the one place
-- to act on it. The moment `v_ship.sunk` is true, insert an already-fired
-- 'miss' claim for the sinking team on every ring tile that team has not
-- already claimed. That is exactly what a manual claim-then-fire-a-miss would
-- have produced, just without the trip: `tiles_for_me` reveals the tile the
-- same way, `enemyShots`/`ship_status` are untouched (a claim with no ship
-- underneath can never count as a hit), and the existing
-- `unique (team_id, tile_id)` constraint is what makes this safe to run even
-- when the team already holds a claim on one of those squares -- that row is
-- left alone rather than overwritten.
--
-- Deliberately scoped to `v_ship_id`'s own cells only: a second hull sinking
-- later gets its own ring, and a tile that happens to sit between two hulls
-- gets revealed by whichever sinks first.
--
-- No new game_event: `ship_sunk` already triggers an immediate (non-delayed)
-- refetch in useGame.js, which is enough for the newly revealed tiles to
-- appear the moment the sinking does.
--
-- Body is otherwise character-for-character 0027's `fire_tile`.

create or replace function fire_tile(p_claim_id uuid)
returns shot_result
language plpgsql security definer set search_path = public as $$
declare
  v_claim    tile_claims%rowtype;
  v_tile     tiles%rowtype;
  v_game_id  uuid;
  v_status   game_status;
  v_enemy_id uuid;
  v_result   shot_result;
  v_ship_id  uuid;
  v_ship     record;
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

  -- The game has to still be running. Without this a claim left open when the
  -- match ended can be fired afterwards, and the winner update below rewrites
  -- who won.
  select status into v_status from games where id = v_game_id;
  if v_status <> 'active' then
    raise exception 'The game is % — no more shots', v_status;
  end if;

  select id into v_enemy_id from teams
   where game_id = v_game_id and id <> v_claim.team_id;

  select sc.ship_id into v_ship_id
    from ship_cells sc
   where sc.team_id = v_enemy_id and sc.row = v_tile.row and sc.col = v_tile.col;

  v_result := case when v_ship_id is null then 'miss' else 'hit' end;

  update tile_claims
     set status = 'fired', result = v_result, fired_by = auth.uid(), fired_at = now()
   where id = p_claim_id;

  insert into game_events (game_id, team_id, type, payload)
  values (v_game_id, v_claim.team_id, 'shot_fired',
          jsonb_build_object('tile_id', v_tile.id,
                             'position', v_tile.position, 'result', v_result,
                             'by', auth.uid()));

  if v_result = 'hit' then
    -- Read once: the size announced and the sunk decision must come from the
    -- same row, or a wrong `ships.size` creeps back in through the payload.
    select * into v_ship from ship_status where ship_id = v_ship_id;

    if v_ship.sunk then
      insert into game_events (game_id, team_id, type, payload)
      values (v_game_id, v_claim.team_id, 'ship_sunk',
              jsonb_build_object('ship_id', v_ship_id,
                                 'size', v_ship.size,
                                 'victim_team_id', v_enemy_id));

      -- The ring: every neighbour of every cell of this hull, minus the
      -- hull's own cells, minus anything the sinking team already holds a
      -- claim on. Guaranteed water by the no-touching rule, so it costs the
      -- sinking team nothing to learn it.
      insert into tile_claims (team_id, tile_id, status, claimed_at, fired_at, result)
      select v_claim.team_id, ring_tile.id, 'fired', now(), now(), 'miss'
        from ship_cells hull
        cross join generate_series(-1, 1) as dr
        cross join generate_series(-1, 1) as dc
        join tiles ring_tile
          on ring_tile.game_id = v_game_id
         and ring_tile.row = hull.row + dr
         and ring_tile.col = hull.col + dc
       where hull.ship_id = v_ship_id
         and not (dr = 0 and dc = 0)
         and not exists (
               select 1 from ship_cells own
                where own.ship_id = v_ship_id
                  and own.row = ring_tile.row and own.col = ring_tile.col
             )
      on conflict (team_id, tile_id) do nothing;

      if not exists (select 1 from ship_status where team_id = v_enemy_id and not sunk) then
        -- `and status = 'active'` so a win can never overwrite a win.
        update games set status = 'finished', winner_team_id = v_claim.team_id, ended_at = now()
         where id = v_game_id and status = 'active';

        if found then
          insert into game_events (game_id, team_id, type, payload)
          values (v_game_id, v_claim.team_id, 'game_won',
                  jsonb_build_object('loser_team_id', v_enemy_id));
        end if;
      end if;
    end if;
  end if;

  return v_result;
end;
$$;

revoke execute on function fire_tile(uuid) from public, anon;
grant  execute on function fire_tile(uuid) to authenticated;
