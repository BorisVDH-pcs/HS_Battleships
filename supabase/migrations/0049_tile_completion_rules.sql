-- Tiles that are finished by WHICH things you have, not by how many.
--
-- (No tile text in this file: this repo is public and the tile contents are
-- secret #2. Shapes described in the abstract, as in 0025, 0046 and 0048.)
--
-- 0046 made a tile a SUM: each drop is worth points, any mix reaching the
-- target finishes it, and the same drop may be handed in as many times as a
-- team got it. That is right for a tile that prices a boss's drop table, and it
-- is wrong for a whole class of tiles in the V4 sheet, which ask for a SET:
--
--   * one complete armour set out of several, any one of them;
--   * one drop from each of five bosses;
--   * two DIFFERENT pieces of the same item;
--   * two different drops from each of three raids;
--   * a two-part recipe, or alternatively a single item that replaces it.
--
-- None of those is expressible as a sum, because a sum cannot tell two of the
-- same thing from two different things — the exact distinction every one of
-- them turns on. Pricing them anyway would let a team finish "one unique from
-- each of five bosses" with five uniques from one boss.
--
-- So this adds ONE idea and three rules built on it.
--
--   The idea: an option may name a GROUP it belongs to. An option with no
--   group is its own group, which is what makes "five different bosses" and
--   "two different pieces from one set" the same mechanism with different
--   grouping rather than two features.
--
--   The rules, on `tiles.completion`:
--     points   — today's behaviour, unchanged and still the default. Sum the
--                points, repeats allowed.
--     one_set  — finished when ANY ONE group is complete: every option in it
--                submitted, each counting once.
--     each_set — finished when EVERY group has at least `per_set` distinct
--                options submitted. With ungrouped options that reads as "all
--                of these, one each".
--     value    — no options at all. The submitter types what the drop was
--                worth and the tile finishes when the total reaches the target.
--                For the tiles that ask for an amount of GP rather than a
--                count of items.
--
-- A tile that says nothing is `points` with no groups, which is exactly what
-- every existing row already is — so there is no backfill here, and nothing
-- already in the database changes behaviour.
--
-- SECURITY: a group name is tile content, like a label and for the same
-- reason — "Dharok" on a square names it as surely as the tile name does. It
-- rides inside `tile_options`, which already has RLS on with a select policy of
-- `false` and is only ever read through a definer function gated on the reading
-- team having CLAIMED the tile (0046). Nothing here widens that.
--
-- TRUST: `value` lets a player type the number that scores their own tile.
-- That is deliberate and is the same trust model as early completion (0025):
-- the organiser reviews every screenshot, the typed figure is recorded next to
-- the image that justifies it, and a wrong one is visible in the review screen.
-- It is not a hole so much as a smaller version of the hole that already
-- exists, and it is the only way to score "250m in unique drops" without
-- pricing every item in the game.

-- ============================================================
-- 1. Room for a target that is an amount of GP
-- ============================================================
-- 250 does not fit in the 1..30 that 0025 set for a count of screenshots, and
-- `tile_evidence.points` has to hold a typed figure of the same size. Both
-- widen to 1000; the tighter bound stays on `tile_options.points`, which is
-- still a price per drop and has no business being large.

alter table tiles drop constraint if exists tiles_required_evidence_check;
alter table tiles add  constraint tiles_required_evidence_check
  check (required_evidence >= 1 and required_evidence <= 1000);

alter table tile_evidence drop constraint if exists tile_evidence_points_check;
alter table tile_evidence add  constraint tile_evidence_points_check
  check (points >= 1 and points <= 1000);

-- ============================================================
-- 2. The rule, and the grouping it works on
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'tile_completion') then
    create type tile_completion as enum ('points', 'one_set', 'each_set', 'value');
  end if;
end
$$;

alter table tiles add column if not exists completion tile_completion not null default 'points';
alter table tiles add column if not exists per_set smallint not null default 1
  check (per_set between 1 and 30);

alter table tile_options add column if not exists grp text;

comment on column tiles.completion is
  'How this tile is finished -- see 0049. `points` is the pre-0049 behaviour.';
comment on column tiles.per_set is
  'For `each_set`: how many distinct options each group needs. Ignored otherwise.';
comment on column tile_options.grp is
  'Which set this drop belongs to. NULL means the option is its own group, so '
  'an ungrouped `each_set` tile reads as "all of these, one each".';

-- ============================================================
-- 3. One place that decides whether a tile is done
-- ============================================================
-- Both the trigger that guards the shot and the RPC that fires it need this
-- answer, and 0046 had them computing it separately from the same two numbers.
-- With four rules instead of one, two copies would drift — and the copy that
-- drifts is either a tile that cannot be finished or a shot that fires early.
--
-- STABLE and reading only its own claim, so it is cheap enough to call on
-- every submit.

create or replace function claim_is_complete(p_claim_id uuid)
returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  v_tile     tiles%rowtype;
  v_required int;
  v_points   int;
begin
  select t.* into v_tile
    from tiles t
    join tile_claims c on c.tile_id = t.id
   where c.id = p_claim_id;
  if not found then return false; end if;

  v_required := coalesce(v_tile.required_evidence, 1);

  -- `value` sums the same column `points` does; the difference is only where
  -- the number came from — a price list, or the person submitting.
  if v_tile.completion in ('points', 'value') then
    select coalesce(sum(points), 0) into v_points
      from tile_evidence where claim_id = p_claim_id;
    return v_points >= v_required;
  end if;

  -- Both set rules count DISTINCT options, which is the whole point: `exists`
  -- rather than a count of rows, so handing in the same piece twice moves
  -- nothing. A tile with no options at all can never satisfy either rule, and
  -- returns false rather than vacuously true — hence the `total > 0` guard on
  -- each_set, where "every group has enough" is otherwise true of no groups.
  if v_tile.completion = 'one_set' then
    return exists (
      select 1 from (
        select coalesce(o.grp, o.label) as g,
               count(*) as total,
               count(*) filter (where exists (
                 select 1 from tile_evidence e
                  where e.claim_id = p_claim_id and e.option_id = o.id
               )) as have
          from tile_options o
         where o.tile_id = v_tile.id
         group by 1
      ) s
      where s.have = s.total
    );
  end if;

  if v_tile.completion = 'each_set' then
    return exists (select 1 from tile_options where tile_id = v_tile.id)
       and not exists (
      select 1 from (
        select coalesce(o.grp, o.label) as g,
               count(*) as total,
               count(*) filter (where exists (
                 select 1 from tile_evidence e
                  where e.claim_id = p_claim_id and e.option_id = o.id
               )) as have
          from tile_options o
         where o.tile_id = v_tile.id
         group by 1
      ) s
      -- least(): a group smaller than per_set would otherwise be impossible to
      -- satisfy and would lock the tile forever. The paste box refuses to save
      -- one, so this is the second line of defence rather than the first.
      where s.have < least(v_tile.per_set, s.total)
    );
  end if;

  return false;
end;
$$;

revoke execute on function claim_is_complete(uuid) from public, anon;
grant  execute on function claim_is_complete(uuid) to authenticated;

-- ============================================================
-- 4. The guard on the table
-- ============================================================
-- Still on the table rather than inside fire_tile(), for the reason 0021 gives:
-- a rule that lives on the table cannot be stepped around by an RPC, a
-- service-role call, or a hand-written UPDATE.

create or replace function enforce_evidence_before_fire() returns trigger
language plpgsql set search_path = public as $$
declare
  v_have int;
begin
  if new.status <> 'fired' or old.status = 'fired' then
    return new;
  end if;

  -- Declared done by the team (0025). complete_tile_early() has already checked
  -- that the tile allows it; what must hold here is that SOMETHING was
  -- submitted, so the organiser has a screenshot to judge.
  if new.completed_early then
    select count(*) into v_have from tile_evidence where claim_id = new.id;
    if v_have < 1 then
      raise exception 'An early completion still needs at least one screenshot';
    end if;
    return new;
  end if;

  if not claim_is_complete(new.id) then
    raise exception 'This tile is not finished yet';
  end if;

  return new;
end;
$$;

-- ============================================================
-- 5. Submitting
-- ============================================================
-- A fifth argument, so the 4-argument version goes rather than staying
-- alongside: an added argument with a default makes the old call ambiguous and
-- Postgres refuses it at call time with "function is not unique" — from the
-- client, mid-event, which is the worst place to find out. (0046 dropped the
-- 3-argument version for exactly this.)

drop function if exists add_evidence(uuid, text, text, uuid);

create function add_evidence(
  p_claim_id     uuid,
  p_storage_path text,
  p_public_url   text default null,
  p_option_id    uuid default null,
  p_amount       int  default null
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
  v_required  int;
  v_result    shot_result;
  v_will_fire boolean;
  v_left      int;
  v_has_opts  boolean;
  v_opt       tile_options%rowtype;
  -- Held separately from v_opt: on a tile without options v_opt is never
  -- assigned, and reading a field off an unassigned rowtype is exactly the kind
  -- of thing that works until the first tile without options.
  v_opt_label text;
  v_award     int := 1;
  v_sets      boolean;
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
  v_sets := v_tile.completion in ('one_set', 'each_set');

  -- ---- what this screenshot is worth ------------------------------------
  if v_tile.completion = 'value' then
    if p_option_id is not null then
      raise exception 'This tile is scored on the value you enter, not on a drop list';
    end if;
    if p_amount is null then
      raise exception 'Say what this drop was worth';
    end if;
    if p_amount < 1 or p_amount > 1000 then
      raise exception 'That value must be between 1 and 1000';
    end if;
    v_award := p_amount;

  else
    if p_amount is not null then
      raise exception 'This tile is not scored on a typed value';
    end if;

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

      -- On a set tile a repeat is worth nothing, so it is refused rather than
      -- silently banked: a team that submits the same piece twice believing it
      -- counted would find out only when the tile failed to fire.
      if v_sets and exists (
           select 1 from tile_evidence
            where claim_id = p_claim_id and option_id = p_option_id
         ) then
        raise exception 'You have already submitted %  for this tile', v_opt.label;
      end if;

      v_award     := case when v_sets then 1 else v_opt.points end;
      v_opt_label := v_opt.label;
    elsif v_has_opts then
      raise exception 'Say which drop this screenshot shows';
    end if;
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
  v_will_fire := claim_is_complete(p_claim_id);

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
            'completion', v_tile.completion::text,
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

revoke execute on function add_evidence(uuid, text, text, uuid, int) from public, anon;
grant  execute on function add_evidence(uuid, text, text, uuid, int) to authenticated;

-- ============================================================
-- 6. Early completion stays a `points` affair
-- ============================================================
-- 0046 refused it on a priced tile because the prices already say when the tile
-- is done. The same holds, more strongly, for a set: "any one full set" has no
-- shorter route to argue about, and a typed value is already whatever the team
-- says it is.

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

  if v_tile.completion <> 'points' then
    raise exception 'This tile says exactly when it is done -- finish it that way';
  end if;

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
-- 7. The board a team can see
-- ============================================================
-- Each option now carries its group and whether this team has already handed it
-- in, which is what lets the card grey out a piece it already has and show the
-- sets filling up. `taken` is per CLAIM, so it is naturally empty for a tile
-- nobody has locked in — and the whole `options` field stays claim-gated as it
-- has been since 0046.
--
-- Another RETURNS TABLE change, so another drop, rebuild and regrant. Miss the
-- regrant and every player loses the board (0014 learned this the hard way).

drop function if exists tiles_for_me(uuid);

create function tiles_for_me(p_game_id uuid)
returns table (
  id uuid, game_id uuid, "row" smallint, col smallint, "position" smallint,
  revealed boolean, name text, icon text,
  required_evidence smallint, evidence_count integer, early_complete boolean,
  claim_id uuid, claim_status claim_status, claim_result shot_result,
  previewed boolean, ship_sunk boolean,
  evidence_points integer, options jsonb, description text,
  completion text, per_set smallint
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
                        'id', o.id, 'label', o.label, 'points', o.points,
                        'grp', o.grp,
                        'taken', exists (select 1 from tile_evidence e
                                          where e.claim_id = c.id and e.option_id = o.id)
                      ) order by o.sort, o.label), '[]'::jsonb)
                 from tile_options o where o.tile_id = t.id)
         end as options,
    -- Claim-gated (0048): this is cost, not identity, so a pet jar preview
    -- does not carry it.
    case when c.id is not null then t.description end as description,
    case when c.id is not null then t.completion::text end as completion,
    case when c.id is not null then t.per_set end as per_set
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
-- 8. The organiser's own board
-- ============================================================

drop function if exists admin_list_tiles(uuid);

create function admin_list_tiles(p_game_id uuid)
returns table (id uuid, "row" smallint, col smallint, "position" smallint,
               name text, icon text, required_evidence smallint,
               early_complete boolean, options jsonb, description text,
               completion text, per_set smallint)
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  return query
    select t.id, t.row, t.col, t.position, t.name, t.icon,
           t.required_evidence, t.early_complete,
           (select coalesce(jsonb_agg(jsonb_build_object(
                     'id', o.id, 'label', o.label, 'points', o.points, 'grp', o.grp
                   ) order by o.sort, o.label), '[]'::jsonb)
              from tile_options o where o.tile_id = t.id),
           t.description, t.completion::text, t.per_set
      from tiles t where t.game_id = p_game_id order by t.position;
end;
$$;

revoke execute on function admin_list_tiles(uuid) from public, anon;
grant  execute on function admin_list_tiles(uuid) to authenticated;

-- ============================================================
-- 9. Saving a board that has rules on it
-- ============================================================
-- The rule arrives as a string and is cast rather than validated by hand: an
-- unknown value raises on the cast and the whole paste rolls back, which is the
-- right outcome for a hundred lines that were meant to be one board.

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

  insert into tiles (game_id, row, col, name, icon, required_evidence,
                     early_complete, description, completion, per_set)
  select p_game_id,
         (t ->> 'row')::smallint,
         (t ->> 'col')::smallint,
         coalesce(nullif(btrim(t ->> 'name'), ''), 'Tile'),
         nullif(regexp_replace(btrim(coalesce(t ->> 'icon', '')),
                               '[^A-Za-z0-9_-]', '', 'g'), ''),
         least(greatest(coalesce((nullif(btrim(t ->> 'amount'), ''))::int, 1), 1), 1000),
         coalesce((t ->> 'early')::boolean, false),
         nullif(left(btrim(coalesce(t ->> 'description', '')), 500), ''),
         coalesce(nullif(btrim(coalesce(t ->> 'rule', '')), ''), 'points')::tile_completion,
         least(greatest(coalesce((nullif(btrim(t ->> 'perSet'), ''))::smallint, 1), 1), 30)
    from jsonb_array_elements(p_tiles) t;

  -- Joined back on (row, col) rather than carried through a RETURNING: the
  -- insert above is a single set-returning statement and its output order is
  -- not something to rely on. (game_id, row, col) is unique, so the join is
  -- exact.
  insert into tile_options (tile_id, label, points, sort, grp)
  select tl.id,
         left(btrim(o.val ->> 'label'), 80),
         least(greatest(coalesce((o.val ->> 'points')::smallint, 1), 1), 30),
         (o.ord - 1)::smallint,
         nullif(left(btrim(coalesce(o.val ->> 'grp', '')), 40), '')
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

  -- Caught here as well as in the paste box, because a board saved through any
  -- other route would otherwise contain a tile that can never be finished.
  if exists (
    select 1 from tiles t
     where t.game_id = p_game_id
       and t.completion in ('one_set', 'each_set')
       and not exists (select 1 from tile_options o where o.tile_id = t.id)
  ) then
    raise exception 'A set tile needs the drops that make up its sets';
  end if;

  if exists (
    select 1 from tiles t
     where t.game_id = p_game_id
       and t.completion = 'value'
       and exists (select 1 from tile_options o where o.tile_id = t.id)
  ) then
    raise exception 'A tile scored on typed value cannot also list drops';
  end if;

  return v_count;
end;
$$;

revoke execute on function admin_set_tiles(uuid, jsonb) from public, anon;
grant  execute on function admin_set_tiles(uuid, jsonb) to authenticated;

-- ============================================================
-- 10. The organiser's progress view
-- ============================================================
-- `completion` joins the row so "fired with 4 of 6" can be read correctly: on a
-- set tile that is four distinct pieces, not four points, and without the rule
-- the number is ambiguous.

drop function if exists admin_tile_progress(uuid);

create function admin_tile_progress(p_game_id uuid)
returns table (team_id uuid, team_name text, tile_id uuid, "position" smallint,
               tile_name text, required_evidence smallint,
               claim_id uuid, status claim_status, result shot_result,
               evidence_count int, evidence_points int, option_count int,
               completion text)
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
           (select count(*)::int from tile_options o where o.tile_id = t.id),
           t.completion::text
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
-- 11. The broadcast line
-- ============================================================
-- Only evidence_submitted changes. A running "6/10" is meaningful when the tile
-- is a sum and misleading when it is a set — three of the four Dharok pieces is
-- not "3 of 4 points" — so a set tile names the drop and stops there, and the
-- fraction is kept for the rules that actually have one. `value` says the total
-- it is counting toward, since that IS a sum.
--
-- The label stays safe here for the reason 0035 and 0046 give: this event type
-- is readable by the submitting team alone, and relay_flush posts it to that
-- team's own channel or to none at all.

create or replace function discord_line(p_event game_events)
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  v_team text;
  v_pos  int := (p_event.payload ->> 'position')::int;
  v_at   text;
  v_img  text := nullif(btrim(coalesce(p_event.payload ->> 'image_url', '')), '');
  v_opt  text := nullif(btrim(coalesce(p_event.payload ->> 'option_label', '')), '');
  v_rule text := coalesce(p_event.payload ->> 'completion', 'points');
  v_who  text;
begin
  select name into v_team from teams where id = p_event.team_id;
  v_team := coalesce(v_team, 'Someone');
  v_who  := coalesce(p_event.payload ->> 'uploaded_by_name', v_team);

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
      case
        when v_rule in ('one_set', 'each_set') and v_opt is not null then
          format('**%s** submitted **%s** for **%s**.',
                 v_who, v_opt, coalesce(p_event.payload ->> 'tile_name', 'a tile'))
        when v_rule = 'value' then
          format('**%s** submitted a drop worth **%sm** for **%s** (%s/%sm).',
                 v_who, p_event.payload ->> 'points_awarded',
                 coalesce(p_event.payload ->> 'tile_name', 'a tile'),
                 p_event.payload ->> 'points_total',
                 p_event.payload ->> 'required_evidence')
        when v_opt is not null then
          format('**%s** submitted **%s** for **%s** — %s points (%s/%s).',
                 v_who, v_opt, coalesce(p_event.payload ->> 'tile_name', 'a tile'),
                 p_event.payload ->> 'points_awarded',
                 p_event.payload ->> 'points_total',
                 p_event.payload ->> 'required_evidence')
        else
          format('**%s** submitted proof for **%s** (%s/%s).',
                 v_who, coalesce(p_event.payload ->> 'tile_name', 'a tile'),
                 p_event.payload ->> 'evidence_count',
                 p_event.payload ->> 'required_evidence')
      end
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
