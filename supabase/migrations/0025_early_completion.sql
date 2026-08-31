-- Tiles with more than one route to done.
--
-- (No tile text in this file, deliberately: this repo is public and the tile
-- contents are secret #2. The shapes below are described in the abstract.)
--
-- Some tasks can be finished several ways, and the ways cost different numbers
-- of drops -- "three of this, nine of that, or eighteen of the other". Others
-- ask for one complete set out of several candidate sets, where the worst case
-- is a pigeonhole count rather than the set size: six candidate sets of four
-- pieces means nineteen pieces before one set must be complete. Pricing those at
-- the CHEAPEST route was wrong -- a team taking the long way round would have
-- fired after three uploads and sat there looking under-evidenced. Pricing them
-- at the dearest route alone is worse: a team that finished in four would be
-- stuck.
--
-- So the count is the worst case, and the team says when it is actually done.
-- Boris's framing: the amount should be the maximum needed, with an early
-- completion for the tiles where a cheaper route exists, and the plain amount
-- everywhere the number is unambiguous.
--
-- Three things follow.
--
-- 1. The 10 cap has to go. The board has a tile that plainly asks for twenty of
--    something, with no shorter route at all, and the set-completion worst case
--    is nineteen. 30 leaves headroom without pretending an organiser will ever
--    want 100.
--
-- 2. `early_complete` is per tile, and is NOT a free pass on every tile: a team
--    can only declare a tile done if the organiser marked that tile as having
--    more than one route. Otherwise a tile that plainly asks for five drops
--    would be one button press.
--
-- 3. An early completion is SELF-DECLARED, so it must be visible as such. The
--    claim records it, and at least one screenshot is still required -- without
--    that floor, claim-then-declare would be a free shot with no proof at all.
--    The organiser needs no new function to find them: admin_tile_progress
--    already returns required_evidence, status and evidence_count, so an early
--    completion reads as fired with fewer than required.
--
-- The trigger from 0021 stays exactly as strict for every other tile. It is
-- what makes "fully evidenced but still active is impossible" (0023) true, and
-- the point here is to add a second legitimate way to satisfy it, not to weaken
-- the first.

alter table tiles       add column if not exists early_complete  boolean not null default false;
alter table tile_claims add column if not exists completed_early boolean not null default false;

-- The 10 lives in two places, and raising only the clamp inside
-- admin_set_tiles gets you a check-constraint violation from the table instead
-- of a silently clamped number. Both have to move. (Postgres caught this on the
-- first import attempt, which is the good outcome -- the clamp alone would have
-- quietly stored 10 where 19 was meant.)
alter table tiles drop constraint if exists tiles_required_evidence_check;
alter table tiles add  constraint tiles_required_evidence_check
  check (required_evidence >= 1 and required_evidence <= 30);


-- Reads `early` alongside `amount`, and clamps to 1..30 rather than 1..10.
create or replace function admin_set_tiles(p_game_id uuid, p_tiles jsonb)
returns integer
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

  insert into tiles (game_id, row, col, name, icon, required_evidence, early_complete)
  select p_game_id,
         (t ->> 'row')::smallint,
         (t ->> 'col')::smallint,
         coalesce(nullif(btrim(t ->> 'name'), ''), 'Tile'),
         nullif(regexp_replace(btrim(coalesce(t ->> 'icon', '')),
                               '[^A-Za-z0-9_-]', '', 'g'), ''),
         least(greatest(coalesce((nullif(btrim(t ->> 'amount'), ''))::smallint, 1), 1), 30),
         coalesce((t ->> 'early')::boolean, false)
    from jsonb_array_elements(p_tiles) t;

  return v_count;
end;
$$;


-- Same rule as 0021, plus the second legitimate route.
create or replace function enforce_evidence_before_fire() returns trigger
language plpgsql set search_path = public as $$
declare
  v_required smallint;
  v_have     int;
begin
  if new.status <> 'fired' or old.status = 'fired' then
    return new;
  end if;

  select required_evidence into v_required from tiles where id = new.tile_id;
  select count(*) into v_have from tile_evidence where claim_id = new.id;

  -- Declared done by the team. complete_tile_early() has already checked that
  -- the tile allows it; what must hold here is that SOMETHING was submitted,
  -- so the organiser has a screenshot to judge.
  if new.completed_early then
    if v_have < 1 then
      raise exception 'An early completion still needs at least one screenshot';
    end if;
    return new;
  end if;

  if v_have < coalesce(v_required, 1) then
    raise exception 'This tile needs % piece(s) of evidence, and has %',
      coalesce(v_required, 1), v_have;
  end if;

  return new;
end;
$$;


-- "We got there by the short route." Fires the shot, marked as declared.
create or replace function complete_tile_early(p_claim_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_claim  tile_claims%rowtype;
  v_tile   tiles%rowtype;
  v_have   int;
  v_result shot_result;
begin
  -- Locked for the same reason add_evidence locks: two members pressing this at
  -- once must not both fire.
  select * into v_claim from tile_claims where id = p_claim_id for update;
  if not found then raise exception 'No such tile claim'; end if;

  if not exists (select 1 from team_members
                  where team_id = v_claim.team_id and profile_id = auth.uid()) then
    raise exception 'That tile belongs to the other team';
  end if;

  if v_claim.status = 'fired' then
    raise exception 'That tile has already been fired';
  end if;

  select * into v_tile from tiles where id = v_claim.tile_id;
  if not v_tile.early_complete then
    raise exception 'This tile has only one route to done — submit the evidence it asks for';
  end if;

  select count(*) into v_have from tile_evidence where claim_id = p_claim_id;
  if v_have < 1 then
    raise exception 'Submit at least one screenshot before completing this tile';
  end if;

  -- Set first, so the trigger on the status change below sees the declaration.
  update tile_claims set completed_early = true where id = p_claim_id;

  v_result := fire_tile(p_claim_id);

  return jsonb_build_object(
    'fired',          true,
    'result',         v_result,
    'evidence_count', v_have,
    'declared_early', true
  );
end;
$$;

revoke execute on function complete_tile_early(uuid) from public, anon;
grant  execute on function complete_tile_early(uuid) to authenticated;


-- Both of these gain a column, and `create or replace` cannot change a RETURNS
-- TABLE, so they are dropped and rebuilt -- which drops their grants with them.
-- Re-applied below, in the same migration, or every player silently loses the
-- board. (0014 learned this the hard way; see the handover.)
drop function if exists tiles_for_me(uuid);

create function tiles_for_me(p_game_id uuid)
returns table (
  id uuid, game_id uuid, "row" smallint, col smallint, "position" smallint,
  revealed boolean, name text, icon text,
  required_evidence smallint, evidence_count integer, early_complete boolean,
  claim_id uuid, claim_status claim_status, claim_result shot_result
)
language sql stable security definer set search_path = public as $$
  select t.id, t.game_id, t.row, t.col, t.position,
    (c.id is not null) as revealed,
    case when c.id is not null then t.name end as name,
    case when c.id is not null then t.icon end as icon,
    case when c.id is not null then t.required_evidence end as required_evidence,
    case when c.id is not null
         then (select count(*) from tile_evidence e where e.claim_id = c.id)
         else 0 end::int as evidence_count,
    -- Gated like the rest: which squares have a short route is a property of
    -- the task, and the task is secret until the team claims it.
    case when c.id is not null then t.early_complete end as early_complete,
    c.id, c.status, c.result
  from tiles t
  left join tile_claims c on c.tile_id = t.id
       and c.team_id = my_team_in_game(p_game_id)
  where t.game_id = p_game_id
  order by t.position;
$$;

revoke execute on function tiles_for_me(uuid) from public, anon;
grant  execute on function tiles_for_me(uuid) to authenticated;


drop function if exists admin_list_tiles(uuid);

create function admin_list_tiles(p_game_id uuid)
returns table (id uuid, "row" smallint, col smallint, "position" smallint,
               name text, icon text, required_evidence smallint,
               early_complete boolean)
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  return query
    select t.id, t.row, t.col, t.position, t.name, t.icon,
           t.required_evidence, t.early_complete
      from tiles t
     where t.game_id = p_game_id
     order by t.position;
end;
$$;

revoke execute on function admin_list_tiles(uuid) from public, anon;
grant  execute on function admin_list_tiles(uuid) to authenticated;
