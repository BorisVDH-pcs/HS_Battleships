-- Tiles where the drops are worth different amounts.
--
-- (No tile text in this file: this repo is public and the tile contents are
-- secret #2. Shapes described in the abstract, as in 0025.)
--
-- 0025 met this problem with a blunt instrument. Some tiles offer several
-- drops of plainly unequal value -- one rare, one common, one in between -- and
-- a team may finish by any mix of them. `required_evidence` could only count
-- screenshots, so such a tile was priced at its WORST case and given
-- `early_complete`: a self-declared "we are done" button. That works, but the
-- organiser cannot tell a genuine short route from an optimistic one, and the
-- number on the card is a count nobody is actually working toward.
--
-- So the count becomes a SUM. Each option carries a point value, every
-- screenshot is worth the points of the option it shows, and the tile fires
-- when the total reaches the target -- or passes it, since a team that hands in
-- the expensive drop last should not be punished for overshooting.
--
-- This is a generalisation, not a replacement. A tile with no options behaves
-- exactly as before: every screenshot is worth 1 point, and the target is the
-- same `required_evidence` it always was. That is why there is no backfill in
-- this file and no new target column -- `required_evidence` IS the target, and
-- for an unweighted tile "3 points" and "3 screenshots" are the same sentence.
--
--   Boris's rules, from the design conversation:
--     * an option may be submitted as many times as a team likes -- three of a
--       2-point drop is a legitimate route to 6;
--     * options are entered in the same paste box as everything else;
--     * `early_complete` stays for tiles WITHOUT options, and is refused on
--       tiles with them -- a priced tile already says exactly when it is done,
--       and leaving the escape hatch open would let a team skip the pricing.
--
-- SECURITY: an option label is tile content. "Fire cape" identifies the square
-- as surely as the tile name does, so `tile_options` gets the same treatment as
-- `tiles`: RLS on, a select policy of `false`, and every read through a definer
-- function gated on the reading team having CLAIMED that tile. Labels may
-- appear in `evidence_submitted` (team-private since 0035) and nowhere else --
-- never in a global feed line, never in a Discord message to the shared
-- channel. A pet jar preview reveals name and icon but deliberately not the
-- amount (0039); options follow the amount, not the name.

-- ============================================================
-- 1. The options
-- ============================================================

create table if not exists tile_options (
  id      uuid     primary key default gen_random_uuid(),
  tile_id uuid     not null references tiles(id) on delete cascade,
  label   text     not null check (btrim(label) <> ''),
  points  smallint not null check (points between 1 and 30),
  sort    smallint not null default 0
);

create index if not exists tile_options_tile_idx on tile_options (tile_id, sort);

alter table tile_options enable row level security;

-- Mirrors tiles_no_direct_read (0001). Nothing reads this table directly; the
-- only ways in are tiles_for_me (gated on the claim) and the admin functions.
drop policy if exists tile_options_no_direct_read on tile_options;
create policy tile_options_no_direct_read on tile_options for select using (false);

-- ============================================================
-- 2. What a piece of evidence is worth
-- ============================================================
-- `points` is frozen at submit time rather than read back through option_id.
-- Re-pricing a tile mid-event must not retroactively un-fire a shot that was
-- legitimately earned under the old numbers. `on delete set null` on the option
-- keeps that true even if the option row itself goes away.

alter table tile_evidence add column if not exists option_id uuid
  references tile_options(id) on delete set null;
alter table tile_evidence add column if not exists points smallint not null default 1
  check (points between 1 and 30);

comment on column tile_evidence.points is
  'What this screenshot was worth when submitted. 1 for a tile with no options. '
  'Frozen deliberately -- see 0046.';

-- ============================================================
-- 3. Firing on the sum, not the count
-- ============================================================
-- Still on the table rather than inside fire_tile(), for the reason 0021 gives:
-- a rule that lives on the table cannot be stepped around by an RPC, a
-- service-role call, or a hand-written UPDATE.
--
-- Existing rows default to 1 point each, so for every tile already in the
-- database this sum equals the count it replaces and nothing shifts.

create or replace function enforce_evidence_before_fire() returns trigger
language plpgsql set search_path = public as $$
declare
  v_required smallint;
  v_have     int;
  v_points   int;
begin
  if new.status <> 'fired' or old.status = 'fired' then
    return new;
  end if;

  select required_evidence into v_required from tiles where id = new.tile_id;

  select count(*), coalesce(sum(points), 0)
    into v_have, v_points
    from tile_evidence where claim_id = new.id;

  -- Declared done by the team (0025). complete_tile_early() has already checked
  -- that the tile allows it; what must hold here is that SOMETHING was
  -- submitted, so the organiser has a screenshot to judge.
  if new.completed_early then
    if v_have < 1 then
      raise exception 'An early completion still needs at least one screenshot';
    end if;
    return new;
  end if;

  if v_points < coalesce(v_required, 1) then
    raise exception 'This tile needs % point(s), and has %',
      coalesce(v_required, 1), v_points;
  end if;

  return new;
end;
$$;

-- ============================================================
-- 4. Submitting against an option
-- ============================================================
-- The 3-argument version is dropped rather than left alongside: a 4th argument
-- with a default would make the old 3-argument call ambiguous, and Postgres
-- would refuse it at call time with "function is not unique" -- from the
-- client, mid-event, which is the worst place to find out.

drop function if exists add_evidence(uuid, text, text);

create function add_evidence(
  p_claim_id     uuid,
  p_storage_path text,
  p_public_url   text default null,
  p_option_id    uuid default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_claim     tile_claims%rowtype;
  v_tile      tiles%rowtype;
  v_name      text;
  v_prefix    text;
  v_row       tile_evidence;
  v_have      int;
  v_points    int;
  v_required  smallint;
  v_result    shot_result;
  v_will_fire boolean;
  v_left      int;
  v_has_opts  boolean;
  v_opt       tile_options%rowtype;
  -- Held separately from v_opt: on an unweighted tile v_opt is never assigned,
  -- and reading a field off an unassigned rowtype is exactly the kind of thing
  -- that works until the first tile without options.
  v_opt_label text;
  v_award     smallint := 1;
begin
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

  v_prefix := v_tile.game_id || '/' || v_claim.team_id || '/' || v_claim.id || '/';
  if position(v_prefix in p_storage_path) <> 1 then
    raise exception 'That evidence path does not belong to this claim';
  end if;

  select exists (select 1 from tile_options where tile_id = v_tile.id) into v_has_opts;

  -- The option must belong to THIS tile. Without that check a team could name
  -- an option id from any other square and read its points back out of the
  -- response -- a slow but real way to price a tile nobody has claimed.
  if p_option_id is not null then
    if not v_has_opts then
      raise exception 'This tile has no drop options to choose from';
    end if;
    select * into v_opt from tile_options
     where id = p_option_id and tile_id = v_tile.id;
    if not found then raise exception 'That is not one of this tile''s options'; end if;
    v_award     := v_opt.points;
    v_opt_label := v_opt.label;
  elsif v_has_opts then
    raise exception 'Say which drop this screenshot shows';
  end if;

  select display_name into v_name from profiles where id = auth.uid();

  insert into tile_evidence (claim_id, team_id, storage_path, uploaded_by,
                             uploaded_by_name, public_url, option_id, points)
  values (p_claim_id, v_claim.team_id, p_storage_path, auth.uid(),
          coalesce(v_name, 'unknown'), nullif(btrim(coalesce(p_public_url, '')), ''),
          p_option_id, v_award)
  returning * into v_row;

  select count(*), coalesce(sum(points), 0)
    into v_have, v_points
    from tile_evidence where claim_id = p_claim_id;

  v_required  := coalesce(v_tile.required_evidence, 1);
  -- At or past the target. A team that hands in the expensive drop last
  -- overshoots, and that is a finished tile, not an error.
  v_will_fire := v_points >= v_required;

  select count(*) into v_left from tile_claims
   where team_id = v_claim.team_id and status = 'active';
  if v_will_fire then v_left := v_left - 1; end if;

  insert into game_events (game_id, team_id, type, payload)
  values (v_tile.game_id, v_claim.team_id, 'evidence_submitted',
          jsonb_build_object(
            'claim_id', p_claim_id,
            'position', v_tile.position,
            'tile_name', v_tile.name,
            'uploaded_by_name', coalesce(v_name, 'unknown'),
            'evidence_count', v_have,
            'required_evidence', v_required,
            'tiles_left_to_fire', v_left,
            'image_url', v_row.public_url,
            -- Team-private event (0035), so the option label is safe here and
            -- ONLY here. Never add it to a globally readable event type.
            'option_label', v_opt_label,
            'points_awarded', v_award,
            'points_total', v_points,
            'weighted', v_has_opts
          ));

  if v_will_fire then
    v_result := fire_tile(p_claim_id);

    insert into game_events (game_id, team_id, type, payload)
    values (v_tile.game_id, v_claim.team_id, 'slot_freed',
            jsonb_build_object('claim_id', p_claim_id, 'position', v_tile.position));
  end if;

  return jsonb_build_object(
    'evidence_id',       v_row.id,
    'evidence_count',    v_have,
    'required_evidence', v_required,
    'points_awarded',    v_award,
    'points_total',      v_points,
    'fired',             v_result is not null,
    'result',            v_result
  );
end;
$$;

revoke execute on function add_evidence(uuid, text, text, uuid) from public, anon;
grant  execute on function add_evidence(uuid, text, text, uuid) to authenticated;

-- ============================================================
-- 5. Early completion is for unpriced tiles only
-- ============================================================
-- A priced tile already states exactly when it is done. Leaving the escape
-- hatch open on one would let a team skip the pricing entirely, which is the
-- whole thing this migration exists to stop.

create or replace function complete_tile_early(p_claim_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_claim  tile_claims%rowtype;
  v_tile   tiles%rowtype;
  v_have   int;
  v_result shot_result;
begin
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

  if exists (select 1 from tile_options where tile_id = v_tile.id) then
    raise exception 'This tile is scored on points -- submit drops until it is met';
  end if;

  if not v_tile.early_complete then
    raise exception 'This tile has only one route to done -- submit the evidence it asks for';
  end if;

  select count(*) into v_have from tile_evidence where claim_id = p_claim_id;
  if v_have < 1 then
    raise exception 'Submit at least one screenshot before completing this tile';
  end if;

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

-- ============================================================
-- 6. The board a team can see
-- ============================================================
-- Two new columns, so this is a drop and rebuild rather than a replace -- and
-- that drops the grants with it. Re-applied at the bottom of this file, or
-- every player silently loses the board. (0014 learned this the hard way; 0025
-- says the same thing above its own rebuild.)
--
-- `options` and `evidence_points` are gated on `c.id is not null` -- the CLAIM,
-- not the pet jar preview. A preview reveals what a tile is; it has never
-- revealed what it costs, and pricing is part of the cost.

drop function if exists tiles_for_me(uuid);

create function tiles_for_me(p_game_id uuid)
returns table (
  id uuid, game_id uuid, "row" smallint, col smallint, "position" smallint,
  revealed boolean, name text, icon text,
  required_evidence smallint, evidence_count integer, early_complete boolean,
  claim_id uuid, claim_status claim_status, claim_result shot_result,
  previewed boolean, ship_sunk boolean,
  evidence_points integer, options jsonb
)
language sql stable security definer set search_path = public as $$
  select t.id, t.game_id, t.row, t.col, t.position,
    (c.id is not null) as revealed,
    case when c.id is not null or pv.id is not null then t.name end as name,
    case when c.id is not null or pv.id is not null then t.icon end as icon,
    case when c.id is not null then t.required_evidence end as required_evidence,
    case when c.id is not null
         then (select count(*) from tile_evidence e where e.claim_id = c.id)
         else 0 end::int as evidence_count,
    case when c.id is not null then t.early_complete end as early_complete,
    c.id, c.status, c.result,
    (pv.id is not null) as previewed,
    coalesce(
      c.result = 'hit' and not exists (
        select 1
          from ship_cells hull
         where hull.ship_id = (
                 select sc.ship_id
                   from ship_cells sc
                   join teams te on te.id = sc.team_id
                  where te.game_id = t.game_id
                    and te.id <> c.team_id
                    and sc.row = t.row and sc.col = t.col
                  limit 1
               )
           and not exists (
                 select 1
                   from tiles ti2
                   join tile_claims tc2 on tc2.tile_id = ti2.id
                  where ti2.game_id = t.game_id
                    and ti2.row = hull.row and ti2.col = hull.col
                    and tc2.team_id = c.team_id
                    and tc2.status = 'fired'
                    and tc2.result = 'hit'
               )
      ),
      false
    ) as ship_sunk,
    case when c.id is not null
         then (select coalesce(sum(e.points), 0) from tile_evidence e where e.claim_id = c.id)
         else 0 end::int as evidence_points,
    case when c.id is not null
         then (select coalesce(jsonb_agg(jsonb_build_object(
                        'id', o.id, 'label', o.label, 'points', o.points
                      ) order by o.sort, o.label), '[]'::jsonb)
                 from tile_options o where o.tile_id = t.id)
         end as options
  from tiles t
  left join tile_claims c on c.tile_id = t.id
       and c.team_id = my_team_in_game(p_game_id)
  left join pet_jar_previews pv on pv.tile_id = t.id
       and pv.team_id = my_team_in_game(p_game_id)
  where t.game_id = p_game_id
  order by t.position;
$$;

revoke execute on function tiles_for_me(uuid) from public, anon;
grant  execute on function tiles_for_me(uuid) to authenticated;

-- ============================================================
-- 7. The organiser's view
-- ============================================================
-- Same drop-and-regrant rule as above. An organiser sees the points a team has
-- banked next to the target, which is what makes a weighted tile auditable:
-- "fired with 7 of 6" is a finished tile, "fired with 2 of 6" is a bug.

drop function if exists admin_tile_progress(uuid);

create function admin_tile_progress(p_game_id uuid)
returns table (team_id uuid, team_name text, tile_id uuid, "position" smallint,
               tile_name text, required_evidence smallint,
               claim_id uuid, status claim_status, result shot_result,
               evidence_count int, evidence_points int, option_count int)
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  return query
    -- cross join: every team against every tile, so unclaimed squares are rows
    -- too and the client can draw a full 10x10 without filling gaps itself.
    select tm.id, tm.name, t.id, t.position, t.name, t.required_evidence,
           c.id, c.status, c.result,
           (select count(*)::int from tile_evidence e where e.claim_id = c.id),
           (select coalesce(sum(e.points), 0)::int from tile_evidence e where e.claim_id = c.id),
           (select count(*)::int from tile_options o where o.tile_id = t.id)
      from teams tm
      cross join tiles t
      left join tile_claims c on c.tile_id = t.id and c.team_id = tm.id
     where tm.game_id = p_game_id
       and t.game_id = p_game_id
     order by tm.name, t.position;
end;
$$;

revoke execute on function admin_tile_progress(uuid) from public, anon;
grant  execute on function admin_tile_progress(uuid) to authenticated;

-- ============================================================
-- 8. A team's own evidence, with what each piece was worth
-- ============================================================

drop function if exists my_evidence(uuid);

create function my_evidence(p_game_id uuid)
returns table (id uuid, claim_id uuid, storage_path text,
               uploaded_by_name text, created_at timestamptz,
               option_label text, points smallint)
language sql stable security definer set search_path = public as $$
  select e.id, e.claim_id, e.storage_path, e.uploaded_by_name, e.created_at,
         o.label, e.points
    from tile_evidence e
    join tile_claims c on c.id = e.claim_id
    join tiles t on t.id = c.tile_id
    left join tile_options o on o.id = e.option_id
   where t.game_id = p_game_id
     and e.team_id in (select my_team_ids())
   order by e.created_at;
$$;

revoke execute on function my_evidence(uuid) from public, anon;
grant  execute on function my_evidence(uuid) to authenticated;

-- ============================================================
-- 9. Saving the options with the tiles
-- ============================================================
-- admin_set_tiles already deletes and re-inserts every tile for the game, and
-- tile_options cascades off tiles, so the old options go with them. Tiles are
-- locked once a game leaves setup/placement, so this cannot run mid-event.

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

  -- Joined back on (row, col) rather than carried through a RETURNING: the
  -- insert above is a single set-returning statement and its output order is
  -- not something to rely on. (game_id, row, col) is unique, so the join is
  -- exact.
  insert into tile_options (tile_id, label, points, sort)
  select tl.id,
         left(btrim(o.val ->> 'label'), 80),
         least(greatest(coalesce((o.val ->> 'points')::smallint, 1), 1), 30),
         (o.ord - 1)::smallint
    from jsonb_array_elements(p_tiles) t
    join tiles tl
      on tl.game_id = p_game_id
     and tl.row = (t ->> 'row')::smallint
     and tl.col = (t ->> 'col')::smallint
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(t -> 'options') = 'array'
           then t -> 'options' else '[]'::jsonb end
    ) with ordinality as o(val, ord)
   where btrim(coalesce(o.val ->> 'label', '')) <> '';

  return v_count;
end;
$$;

revoke execute on function admin_set_tiles(uuid, jsonb) from public, anon;
grant  execute on function admin_set_tiles(uuid, jsonb) to authenticated;

-- ============================================================
-- 10. The organiser's own board
-- ============================================================
-- admin_list_tiles has returned name and icon only since 0014, so the admin
-- board could never show what a tile costs -- TileBoard reads
-- `required_evidence` off these rows and has been getting undefined. Weighted
-- tiles make that gap worse: pasting a priced board and being shown no prices
-- back is no way to check a hundred lines. Another RETURNS TABLE change, so
-- another drop, rebuild and regrant.

drop function if exists admin_list_tiles(uuid);

create function admin_list_tiles(p_game_id uuid)
returns table (id uuid, "row" smallint, col smallint, "position" smallint,
               name text, icon text, required_evidence smallint,
               early_complete boolean, options jsonb)
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  return query
    select t.id, t.row, t.col, t.position, t.name, t.icon,
           t.required_evidence, t.early_complete,
           (select coalesce(jsonb_agg(jsonb_build_object(
                     'id', o.id, 'label', o.label, 'points', o.points
                   ) order by o.sort, o.label), '[]'::jsonb)
              from tile_options o where o.tile_id = t.id)
      from tiles t where t.game_id = p_game_id order by t.position;
end;
$$;

revoke execute on function admin_list_tiles(uuid) from public, anon;
grant  execute on function admin_list_tiles(uuid) to authenticated;

-- ============================================================
-- 11. The broadcast line
-- ============================================================
-- Only evidence_submitted changes, and only for weighted tiles. The label is
-- safe here for the reason given in 0035 and restated at the top of this file:
-- this event type is readable by the submitting team alone, and relay_flush
-- posts it to that team's own channel or to none at all.

create or replace function discord_line(p_event game_events)
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  v_team text;
  v_pos  int := (p_event.payload ->> 'position')::int;
  v_at   text;
  v_img  text := nullif(btrim(coalesce(p_event.payload ->> 'image_url', '')), '');
  v_opt  text := nullif(btrim(coalesce(p_event.payload ->> 'option_label', '')), '');
begin
  select name into v_team from teams where id = p_event.team_id;
  v_team := coalesce(v_team, 'Someone');

  if v_pos is not null then
    v_at := ' at ' || chr(65 + ((v_pos - 1) % 10)) || (((v_pos - 1) / 10) + 1);
  else
    v_at := '';
  end if;

  return case p_event.type
    when 'fleet_placed'  then format('**%s**''s fleet is set.', v_team)
    when 'game_started'  then '**The game has begun** — fleets are locked.'
    when 'team_renamed'  then format('%s is now **%s**.',
                                     coalesce(p_event.payload ->> 'old_name', 'A team'),
                                     coalesce(p_event.payload ->> 'new_name', v_team))
    when 'tile_claimed'  then format('**%s** locked in a tile%s.', v_team, v_at)
    when 'claim_released' then format('An admin released **%s**''s tile%s.', v_team, v_at)
    when 'shot_fired'    then format('**%s** fired%s — %s', v_team, v_at,
                                     case when p_event.payload ->> 'result' = 'hit'
                                          then '**HIT**' else 'miss.' end)
    when 'ship_sunk'     then format(':boom: **%s** sank a %s-tile ship!',
                                     v_team, p_event.payload ->> 'size')
    when 'game_won'      then format(':trophy: **%s** wins — the enemy fleet is gone.', v_team)
    when 'game_reset'    then case when (p_event.payload ->> 'fleets_cleared')::boolean
                                   then 'The game has been reset — fleets need placing again.'
                                   else 'The game has been reset. Fleets are unchanged.' end
    when 'evidence_submitted' then
      case when v_opt is not null
           then format('**%s** submitted **%s** for **%s** — %s points (%s/%s).',
                       coalesce(p_event.payload ->> 'uploaded_by_name', v_team),
                       v_opt,
                       coalesce(p_event.payload ->> 'tile_name', 'a tile'),
                       p_event.payload ->> 'points_awarded',
                       p_event.payload ->> 'points_total',
                       p_event.payload ->> 'required_evidence')
           else format('**%s** submitted proof for **%s** (%s/%s).',
                       coalesce(p_event.payload ->> 'uploaded_by_name', v_team),
                       coalesce(p_event.payload ->> 'tile_name', 'a tile'),
                       p_event.payload ->> 'evidence_count',
                       p_event.payload ->> 'required_evidence') end
      || case when v_img is not null then E'\n' || v_img else '' end
    when 'slot_freed'    then 'An active tile is available now. Lock in another target.'
    when 'pet_jar_submitted' then format(':jar: **%s** submitted a pet/jar — %s pet jar preview(s) now.',
                                     coalesce(p_event.payload ->> 'submitted_by_name', v_team),
                                     p_event.payload ->> 'pet_jar_count')
                                   || case when v_img is not null then E'\n' || v_img else '' end
    when 'pet_jar_spent' then format(':mag: A pet jar preview was spent on **%s** — %s left.',
                                     coalesce(p_event.payload ->> 'tile_name', 'a tile'),
                                     p_event.payload ->> 'pet_jar_count')
    else p_event.type::text
  end;
end;
$$;

revoke execute on function discord_line(game_events) from public, anon, authenticated;
