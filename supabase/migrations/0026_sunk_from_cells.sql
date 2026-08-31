-- A ship is sunk when every cell it occupies has been hit.
--
-- It used to be "when the number of hits equals `ships.size`", and Boris found
-- what that costs. A ship of five cells whose `size` column said four was
-- announced as sunk -- "sank a 4-tile ship" -- on the FOURTH hit, with four
-- cells and one still afloat. The fifth hit then made the count five, `5 = 4`
-- was false, and the ship quietly **un-sank**: no event, and `sunk` reading
-- false with every cell of it destroyed.
--
-- Three separate weaknesses had to line up, and all three are worth removing.
--
-- 1. `sunk` trusted a denormalised column instead of the cells themselves.
--    `place_fleet` cannot produce a mismatch -- it derives the size from
--    `jsonb_array_length(cells)`, raises if the caller's declared size
--    disagrees, and stores the derived value -- so the app was not the source.
--    That fleet was edited directly in the database. But "the number is right
--    because the only writer keeps it right" is a bad thing to rest a win
--    condition on, when the cells are sitting there to be counted.
--
-- 2. It compared with `=`. Equality means a sink can reverse itself if the
--    count ever moves past the size, which is exactly what happened here. A
--    threshold cannot.
--
-- 3. It counted `tile_claims` rows rather than distinct ship cells. Two fired
--    hit-claims on one square -- which nothing in the schema forbids -- would
--    have counted twice and sunk a ship early all on its own.
--
-- So: count DISTINCT hit cells, against the ship's own cell count, with `>=`.
-- Every one of the three then stops mattering. `size` stays in the view (the
-- feed and the fleet card both print it) but is now the true cell count rather
-- than the stored column, so a wrong `ships.size` can no longer say anything
-- about a game.
--
-- Column names and types are unchanged -- ship_id, team_id, game_id, size
-- smallint, hits bigint, sunk boolean -- and `security_invoker` is respecified,
-- because CREATE OR REPLACE VIEW does not carry view options across.
--
-- The distinct key is the (row, col) pair: ship_cells has no surrogate id, its
-- columns being ship_id, team_id, row, col.

create or replace view ship_status
with (security_invoker = true) as
select
  s.id                                              as ship_id,
  s.team_id,
  t.game_id,
  count(distinct (sc.row, sc.col))::smallint        as size,
  count(distinct (sc.row, sc.col)) filter (where tc.id is not null) as hits,
  count(distinct (sc.row, sc.col)) filter (where tc.id is not null)
    >= count(distinct (sc.row, sc.col))             as sunk
from ships s
join teams t on t.id = s.team_id
join ship_cells sc on sc.ship_id = s.id
left join tiles ti
       on ti.game_id = t.game_id
      and ti.row = sc.row
      and ti.col = sc.col
left join tile_claims tc
       on tc.tile_id = ti.id
      and tc.status  = 'fired'
      and tc.result  = 'hit'
      and tc.team_id <> s.team_id     -- only the opponent's shots count
group by s.id, s.team_id, t.game_id;


-- The sunk announcement should name the size the view derived, not the stored
-- column, for the same reason.
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
  v_status   record;
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
    select * into v_status from ship_status where ship_id = v_ship_id;

    if v_status.sunk then
      insert into game_events (game_id, team_id, type, payload)
      values (v_game_id, v_claim.team_id, 'ship_sunk',
              jsonb_build_object('ship_id', v_ship_id,
                                 'size', v_status.size,
                                 'victim_team_id', v_enemy_id));

      if not exists (select 1 from ship_status where team_id = v_enemy_id and not sunk) then
        update games set status = 'finished', winner_team_id = v_claim.team_id, ended_at = now()
         where id = v_game_id;

        insert into game_events (game_id, team_id, type, payload)
        values (v_game_id, v_claim.team_id, 'game_won',
                jsonb_build_object('loser_team_id', v_enemy_id));
      end if;
    end if;
  end if;

  return v_result;
end;
$$;

revoke execute on function fire_tile(uuid) from public, anon;
grant  execute on function fire_tile(uuid) to authenticated;


-- And catch the corruption at the gate rather than mid-match. start_game
-- already refuses an incomplete board; a fleet whose stored sizes disagree with
-- its cells is just as unready, and this is the last moment anyone is looking.
create or replace function assert_fleets_consistent(p_game_id uuid) returns void
language plpgsql stable security definer set search_path = public as $$
declare
  v_bad text;
begin
  select string_agg(format('%s (says %s, occupies %s)', s.id, s.size, c.n), ', ')
    into v_bad
    from ships s
    join teams t on t.id = s.team_id
    join lateral (select count(*) as n from ship_cells sc where sc.ship_id = s.id) c on true
   where t.game_id = p_game_id
     and s.size <> c.n;

  if v_bad is not null then
    raise exception 'Fleet data is inconsistent — %', v_bad;
  end if;
end;
$$;

revoke execute on function assert_fleets_consistent(uuid) from public, anon;


-- Wired into start_game, unchanged otherwise.
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

  -- Cheap, and the last moment anyone is looking at the board before it counts.
  perform assert_fleets_consistent(p_game_id);

  update games set status = 'active', started_at = now() where id = p_game_id;

  insert into game_events (game_id, type, payload)
  values (p_game_id, 'game_started', jsonb_build_object('by', auth.uid()));
end;
$$;

revoke execute on function start_game(uuid) from public, anon;
grant  execute on function start_game(uuid) to authenticated;


-- Repair any fleet already carrying the mismatch: sizes realigned to the cells
-- actually occupied. On a clean database this matches nothing and is a no-op.
--
-- Note for a replay against the live project: `freeze_fleet_after_placement`
-- rejects any write to `ships` once its game is past placement, so this
-- statement fails if a corrupted fleet belongs to an ACTIVE game -- and it took
-- the whole migration down with it the first time. That is the trigger being
-- right; the repair is cosmetic now, since ship_status no longer reads
-- `ships.size` for anything. Where it must be done anyway, disable that trigger
-- for the one statement, or reset the game to placement first.
update ships s
   set size = c.n
  from (select sc.ship_id, count(*)::smallint as n
          from ship_cells sc group by sc.ship_id) c
 where c.ship_id = s.id
   and s.size <> c.n;
