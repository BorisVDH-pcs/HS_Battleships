-- A drop that may only count so many times.
--
-- The challenge tile is the case nothing on the board could express. It is a
-- points tile -- a price list, a target, finish it however you like -- but every
-- entry also carries a limit: this one is worth 2 and may count four times,
-- that one is worth 7 and may count once. Under `points` as it stood, repeats
-- were unlimited, so the cheapest drop on the list was always a valid route to
-- the whole target: grind one of them fifteen times and the tile is done. That
-- is precisely what the limits exist to forbid.
--
-- WHY NOT A NEW RULE. `points_capped` would have been a sixth entry in the
-- table, and every clause of it except one would have been copied from
-- `points`: the same sum, the same target, the same award at submit time, the
-- same wording on the card and in the feed. The thing that differs is not how
-- the tile finishes, it is what a single drop is allowed to contribute -- which
-- is a property of the OPTION, not of the rule. So the cap goes on the option:
--
--   * `max_times` null -- what every option in the database has today -- is
--     exactly the behaviour of this column's absence. Nothing already saved
--     changes, and no tile has to be re-saved.
--   * It composes. A `points_per_set` tile gets caps for free, and would
--     otherwise have needed a seventh rule to have them.
--   * The rule picker stays five entries long, and "which of these two nearly
--     identical points rules did I want" is a question nobody has to answer.
--
-- WHY OVER-CAP EVIDENCE IS REFUSED RATHER THAN BANKED AT ZERO. The same reason
-- 0049 gives for refusing a repeat on a set tile: a team that submits a fifth
-- fire cape believing it counted would find out only when the tile failed to
-- fire. It is also forced -- `tile_evidence.points` is `check (points between
-- 1 and 30)`, so there is no such thing as a zero-point row to bank.

-- ============================================================
-- 1. The cap
-- ============================================================
-- Nullable, and null means "as many times as you like". That is already true
-- of every row in both tables, so there is no backfill in this file.

alter table tile_options         add column if not exists max_times smallint;
alter table tile_library_options add column if not exists max_times smallint;

do $$
begin
  alter table tile_options add constraint tile_options_max_times_ck
    check (max_times is null or max_times between 1 and 30);
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table tile_library_options add constraint tile_library_options_max_times_ck
    check (max_times is null or max_times between 1 and 30);
exception when duplicate_object then null;
end $$;

comment on column tile_options.max_times is
  'How many times this drop may count toward the tile. Null is unlimited, '
  'which is what every option was before this column existed.';
comment on column tile_library_options.max_times is
  'How many times this drop may count toward the tile. Null is unlimited.';

-- ============================================================
-- 2. A capped tile that cannot be finished
-- ============================================================
-- The sibling of the `each_set` group-size check: a group of one can never
-- yield two DIFFERENT drops, and a price list whose every entry is capped can
-- never reach a target above the sum of those caps. Both leave a tile on a
-- board that no amount of play can close, which is the one class of mistake
-- worth refusing at save time rather than discovering mid-event.
--
-- Only when EVERY option is capped. One uncapped drop on the list makes any
-- target reachable, and that is the ordinary case.

create or replace function assert_points_cap_reachable(
  p_completion tile_completion,
  p_required   int,
  p_options    jsonb,
  p_what       text default 'This tile'
) returns void
language plpgsql immutable set search_path = public as $$
declare
  v_uncapped int;
  v_ceiling  int;
begin
  if p_completion <> 'points' or jsonb_typeof(p_options) <> 'array' then
    return;
  end if;

  select count(*) filter (where nullif(btrim(coalesce(o ->> 'maxTimes', '')), '') is null),
         coalesce(sum(coalesce((nullif(btrim(o ->> 'points'),   ''))::int, 1)
                    * coalesce((nullif(btrim(o ->> 'maxTimes'), ''))::int, 0)), 0)
    into v_uncapped, v_ceiling
    from jsonb_array_elements(p_options) o
   where btrim(coalesce(o ->> 'label', '')) <> '';

  if v_uncapped = 0 and v_ceiling > 0 and v_ceiling < p_required then
    raise exception '% caps every drop, which tops out at % of the % points it asks for',
      p_what, v_ceiling, p_required;
  end if;
end;
$$;

-- ============================================================
-- 3. When such a tile is finished
-- ============================================================
-- The cap is applied by RANK, not by re-reading the option's price: the Nth
-- screenshot of a drop counts, the (N+1)th does not, and each counts whatever
-- it was worth the day it was submitted. 0046 froze `tile_evidence.points` on
-- purpose -- re-pricing a tile mid-event must not un-fire a shot that was
-- legitimately earned -- and summing `least(count, max_times) * o.points` here
-- would have quietly undone that by reaching back through `option_id` for
-- today's number.
--
-- `value` shares this branch and is untouched by it: a value tile has no
-- options, so every row has a null `option_id`, a null `max_times`, and
-- survives the filter.

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

  if v_tile.completion in ('points', 'value') then
    select coalesce(sum(e.points), 0) into v_points
      from (
        select ev.points, o.max_times,
               row_number() over (partition by ev.option_id
                                  order by ev.created_at, ev.id) as rn
          from tile_evidence ev
          left join tile_options o on o.id = ev.option_id
         where ev.claim_id = p_claim_id
      ) e
     where e.max_times is null or e.rn <= e.max_times;
    return v_points >= v_required;
  end if;

  -- Both DISTINCT-set rules count options, not rows, so a cap of 1 is already
  -- implied there and a higher one can never bind. Left exactly as 0049 wrote
  -- them.
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
      where s.have < least(v_tile.per_set, s.total)
    );
  end if;

  -- The same clamp as the points branch, applied inside each group. A left
  -- join rather than 0049's correlated sum, because the rank has to be
  -- computed across the claim's rows before it can be compared to the cap.
  if v_tile.completion = 'points_per_set' then
    return exists (select 1 from tile_options where tile_id = v_tile.id)
       and not exists (
      select 1 from (
        select coalesce(o.grp, o.label) as g,
               coalesce(sum(e.points), 0) as have
          from tile_options o
          left join (
            select ev.option_id, ev.points,
                   row_number() over (partition by ev.option_id
                                      order by ev.created_at, ev.id) as rn
              from tile_evidence ev
             where ev.claim_id = p_claim_id
          ) e on e.option_id = o.id
             and (o.max_times is null or e.rn <= o.max_times)
         where o.tile_id = v_tile.id
         group by 1
      ) s
      where s.have < v_tile.per_set
    );
  end if;

  return false;
end;
$$;

revoke execute on function claim_is_complete(uuid) from public, anon, authenticated;

-- ============================================================
-- 4. Submitting one more than the cap allows
-- ============================================================
-- Refused here, beside the set rules' repeat check and for the same stated
-- reason. Placed after it deliberately: on a set tile the repeat check fires
-- first and says the more specific thing ("you have already submitted X"),
-- and a cap on a set option could never bind anyway.
--
-- Everything else about this function is 0049's, unchanged. The award is still
-- the option's own price -- a capped drop that is still under its cap is worth
-- exactly what an uncapped one would be -- and `claim_is_complete()` is still
-- the only thing that decides whether the shot goes off.

create or replace function add_evidence(
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
  v_used      int;
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

      -- And a capped drop stops counting once it has been counted its number
      -- of times. Refused, not banked at zero: the points column cannot hold a
      -- zero, and a screenshot that silently bought nothing is the failure
      -- this message exists to prevent.
      if v_opt.max_times is not null then
        select count(*) into v_used from tile_evidence
         where claim_id = p_claim_id and option_id = p_option_id;
        if v_used >= v_opt.max_times then
          raise exception '% counts % time(s) on this tile, and you have them all',
            v_opt.label, v_opt.max_times;
        end if;
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
-- 5. What the team can see of the cap
-- ============================================================
-- `got` already says how many of a drop are in (0050). `max_times` beside it is
-- what turns that count into a limit the picker can act on, so a drop that has
-- run out is greyed with its siblings still selectable -- rather than offered,
-- uploaded, and refused by the server a round trip later.
--
-- Claim-gated like everything else in this function: a cap is cost, and a pet
-- jar preview reveals what a tile IS, never what it costs.

create or replace function tiles_for_me(p_game_id uuid)
returns table (
  id uuid, game_id uuid, "row" smallint, col smallint, "position" smallint,
  revealed boolean, name text, icon text,
  required_evidence smallint, evidence_count integer,
  claim_id uuid, claim_status claim_status, claim_result shot_result,
  previewed boolean, ship_sunk boolean,
  evidence_points integer, options jsonb, description text,
  completion text, per_set smallint,
  claimed_by_name text, claimed_at timestamptz
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
                        'grp', o.grp, 'max_times', o.max_times,
                        'taken', exists (select 1 from tile_evidence e
                                          where e.claim_id = c.id and e.option_id = o.id),
                        'got', (select count(*) from tile_evidence e
                                 where e.claim_id = c.id and e.option_id = o.id)
                      ) order by o.sort, o.label), '[]'::jsonb)
                 from tile_options o where o.tile_id = t.id)
         end as options,
    -- Claim-gated (0048): this is cost, not identity, so a pet jar preview
    -- does not carry it.
    case when c.id is not null then t.description end as description,
    case when c.id is not null then t.completion::text end as completion,
    case when c.id is not null then t.per_set end as per_set,
    -- Claim-gated for the same reason the rest is: a previewed-but-unclaimed
    -- tile has no claim, so there is nobody to name. `claimed_by` is nullable
    -- (on delete set null), so a player whose account is gone leaves the
    -- timestamp standing and the name null -- the card handles that.
    p.display_name as claimed_by_name,
    c.claimed_at
  from tiles t
  left join tile_claims c on c.tile_id = t.id
       and c.team_id = my_team_in_game(p_game_id)
  left join profiles p on p.id = c.claimed_by
  left join pet_jar_previews pv on pv.tile_id = t.id
       and pv.team_id = my_team_in_game(p_game_id)
  where t.game_id = p_game_id
  order by t.position;
$$;

revoke execute on function tiles_for_me(uuid) from public, anon;
grant  execute on function tiles_for_me(uuid) to authenticated;

-- ============================================================
-- 6. What the builder reads back
-- ============================================================
-- Both editors round-trip a row through the form and save it again. Without
-- the cap in the row it comes back as null on the next save, so editing a
-- tile's name would silently uncap every drop on it.

create or replace function admin_list_tiles(p_game_id uuid)
returns table (
  id uuid, "row" smallint, col smallint, "position" smallint,
  name text, icon text, required_evidence smallint, options jsonb,
  description text, completion text, per_set smallint, library_id uuid
)
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  return query
    select t.id, t.row, t.col, t.position, t.name, t.icon,
           t.required_evidence,
           (select coalesce(jsonb_agg(jsonb_build_object(
                     'id', o.id, 'label', o.label, 'points', o.points,
                     'grp', o.grp, 'max_times', o.max_times
                   ) order by o.sort, o.label), '[]'::jsonb)
              from tile_options o where o.tile_id = t.id),
           t.description, t.completion::text, t.per_set, t.library_id
      from tiles t where t.game_id = p_game_id order by t.position;
end;
$$;

revoke execute on function admin_list_tiles(uuid) from public, anon;
grant  execute on function admin_list_tiles(uuid) to authenticated;

create or replace function admin_list_library()
returns table (
  id uuid, name text, icon text, description text,
  required_evidence smallint, completion text, per_set smallint,
  tags text[], times_used integer, last_used_at timestamptz, options jsonb
)
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  return query
    select l.id, l.name, l.icon, l.description,
           l.required_evidence,
           l.completion::text, l.per_set, l.tags,
           l.times_used, l.last_used_at,
           (select coalesce(jsonb_agg(jsonb_build_object(
                     'label', o.label, 'points', o.points, 'grp', o.grp,
                     'max_times', o.max_times
                   ) order by o.sort, o.label), '[]'::jsonb)
              from tile_library_options o where o.library_id = l.id)
      from tile_library l
     order by l.times_used desc, l.last_used_at desc nulls last, l.name;
end;
$$;

revoke execute on function admin_list_library() from public, anon;
grant  execute on function admin_list_library() to authenticated;

-- ============================================================
-- 7. Saving one
-- ============================================================
-- `maxTimes` is the payload's name for it, matching the camelCase the rest of
-- the payload already uses (`perSet`, `libraryId`). Absent or blank is null,
-- which is uncapped; anything else is clamped to the column's own 1..30 so a
-- hand-built payload cannot get past the check constraint with a confusing
-- error instead of a clear one.

create or replace function admin_save_library_tile(p_id uuid, p_tile jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id         uuid;
  v_completion tile_completion;
  v_options    int;
  v_name       text;
  v_amount     int;
begin
  if not is_admin() then raise exception 'Admins only'; end if;

  v_name := btrim(coalesce(p_tile ->> 'name', ''));
  if v_name = '' then raise exception 'A library tile needs a name'; end if;

  v_completion := coalesce(nullif(btrim(coalesce(p_tile ->> 'rule', '')), ''),
                           'points')::tile_completion;
  v_amount := least(greatest(coalesce((nullif(btrim(p_tile ->> 'amount'), ''))::int, 1), 1), 1000);
  v_options := (
    select count(*)
      from jsonb_array_elements(
             case when jsonb_typeof(p_tile -> 'options') = 'array'
                  then p_tile -> 'options' else '[]'::jsonb end) o
     where btrim(coalesce(o ->> 'label', '')) <> ''
  );
  perform assert_tile_rule_ok(v_completion, v_options, format('%L', v_name));
  perform assert_points_cap_reachable(v_completion, v_amount,
                                      p_tile -> 'options', format('%L', v_name));

  begin
    insert into tile_library (id, name, icon, description, required_evidence,
                              completion, per_set, tags, created_by)
    values (
      coalesce(p_id, gen_random_uuid()),
      left(v_name, 120),
      nullif(regexp_replace(btrim(coalesce(p_tile ->> 'icon', '')),
                            '[^A-Za-z0-9_-]', '', 'g'), ''),
      nullif(left(btrim(coalesce(p_tile ->> 'description', '')), 500), ''),
      v_amount,
      v_completion,
      least(greatest(coalesce((nullif(btrim(p_tile ->> 'perSet'), ''))::smallint, 1), 1), 30),
      coalesce(
        (select array_agg(distinct lower(btrim(t.value)))
           from jsonb_array_elements_text(
                  case when jsonb_typeof(p_tile -> 'tags') = 'array'
                       then p_tile -> 'tags' else '[]'::jsonb end) t(value)
          where btrim(t.value) <> ''),
        '{}'::text[]),
      auth.uid()
    )
    on conflict (id) do update set
      name              = excluded.name,
      icon              = excluded.icon,
      description       = excluded.description,
      required_evidence = excluded.required_evidence,
      completion        = excluded.completion,
      per_set           = excluded.per_set,
      tags              = excluded.tags
    returning tile_library.id into v_id;
  exception when unique_violation then
    raise exception 'A library tile called % already exists', v_name;
  end;

  delete from tile_library_options where library_id = v_id;

  insert into tile_library_options (library_id, label, points, sort, grp, max_times)
  select v_id,
         left(btrim(o.val ->> 'label'), 80),
         least(greatest(coalesce((o.val ->> 'points')::smallint, 1), 1), 30),
         (o.ord - 1)::smallint,
         nullif(left(btrim(coalesce(o.val ->> 'grp', '')), 40), ''),
         case when nullif(btrim(coalesce(o.val ->> 'maxTimes', '')), '') is null then null
              else least(greatest((o.val ->> 'maxTimes')::smallint, 1), 30)::smallint end
    from jsonb_array_elements(
           case when jsonb_typeof(p_tile -> 'options') = 'array'
                then p_tile -> 'options' else '[]'::jsonb end
         ) with ordinality as o(val, ord)
   where btrim(coalesce(o.val ->> 'label', '')) <> '';

  return v_id;
end;
$$;

revoke execute on function admin_save_library_tile(uuid, jsonb) from public, anon;
grant  execute on function admin_save_library_tile(uuid, jsonb) to authenticated;

create or replace function admin_set_tile(p_game_id uuid,
                                          p_row smallint,
                                          p_col smallint,
                                          p_tile jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_game       games%rowtype;
  v_tile_id    uuid;
  v_was        uuid;
  v_completion tile_completion;
  v_library    uuid;
  v_options    int;
  v_amount     int;
begin
  if not is_admin() then raise exception 'Admins only'; end if;

  select * into v_game from games where id = p_game_id;
  if not found then raise exception 'No such game'; end if;
  if v_game.status not in ('setup', 'placement') then
    raise exception 'Tiles are locked once the game is %', v_game.status;
  end if;
  if p_row < 1 or p_row > v_game.grid_size or p_col < 1 or p_col > v_game.grid_size then
    raise exception 'Square %,% is off a %x% board',
      p_row, p_col, v_game.grid_size, v_game.grid_size;
  end if;

  v_completion := coalesce(nullif(btrim(coalesce(p_tile ->> 'rule', '')), ''),
                           'points')::tile_completion;
  v_amount := least(greatest(coalesce((nullif(btrim(p_tile ->> 'amount'), ''))::int, 1), 1), 1000);
  v_options := (
    select count(*)
      from jsonb_array_elements(
             case when jsonb_typeof(p_tile -> 'options') = 'array'
                  then p_tile -> 'options' else '[]'::jsonb end) o
     where btrim(coalesce(o ->> 'label', '')) <> ''
  );
  perform assert_tile_rule_ok(v_completion, v_options, 'This tile');
  perform assert_points_cap_reachable(v_completion, v_amount,
                                      p_tile -> 'options', 'This tile');

  v_library := nullif(btrim(coalesce(p_tile ->> 'libraryId', '')), '')::uuid;

  -- What was here before, so `times_used` counts squares filled from an entry
  -- rather than clicks. Re-saving the same square from the same entry -- which
  -- is what tweaking a target does -- must not inflate the count.
  select library_id into v_was
    from tiles where game_id = p_game_id and "row" = p_row and col = p_col;

  insert into tiles (game_id, row, col, name, icon, required_evidence,
                     description, completion, per_set, library_id)
  values (
    p_game_id, p_row, p_col,
    coalesce(nullif(btrim(p_tile ->> 'name'), ''), 'Tile'),
    nullif(regexp_replace(btrim(coalesce(p_tile ->> 'icon', '')),
                          '[^A-Za-z0-9_-]', '', 'g'), ''),
    v_amount,
    nullif(left(btrim(coalesce(p_tile ->> 'description', '')), 500), ''),
    v_completion,
    least(greatest(coalesce((nullif(btrim(p_tile ->> 'perSet'), ''))::smallint, 1), 1), 30),
    v_library
  )
  on conflict (game_id, "row", col) do update set
    name              = excluded.name,
    icon              = excluded.icon,
    required_evidence = excluded.required_evidence,
    description       = excluded.description,
    completion        = excluded.completion,
    per_set           = excluded.per_set,
    library_id        = excluded.library_id
  returning id into v_tile_id;

  -- Replaced wholesale rather than diffed: the payload is the whole tile, and
  -- a partial update would leave drops behind from whatever was here before.
  delete from tile_options where tile_id = v_tile_id;

  insert into tile_options (tile_id, label, points, sort, grp, max_times)
  select v_tile_id,
         left(btrim(o.val ->> 'label'), 80),
         least(greatest(coalesce((o.val ->> 'points')::smallint, 1), 1), 30),
         (o.ord - 1)::smallint,
         nullif(left(btrim(coalesce(o.val ->> 'grp', '')), 40), ''),
         case when nullif(btrim(coalesce(o.val ->> 'maxTimes', '')), '') is null then null
              else least(greatest((o.val ->> 'maxTimes')::smallint, 1), 30)::smallint end
    from jsonb_array_elements(
           case when jsonb_typeof(p_tile -> 'options') = 'array'
                then p_tile -> 'options' else '[]'::jsonb end
         ) with ordinality as o(val, ord)
   where btrim(coalesce(o.val ->> 'label', '')) <> '';

  if v_library is not null and (v_was is null or v_was <> v_library) then
    update tile_library
       set times_used = times_used + 1, last_used_at = now()
     where id = v_library;
  end if;

  return v_tile_id;
end;
$$;

revoke execute on function admin_set_tile(uuid, smallint, smallint, jsonb) from public, anon;
grant  execute on function admin_set_tile(uuid, smallint, smallint, jsonb) to authenticated;

-- ============================================================
-- 8. Autofill carries the cap with everything else
-- ============================================================
-- A square filled from the catalogue is a SNAPSHOT of the entry (0051). Losing
-- the cap on the way across would turn a capped catalogue tile into an
-- uncapped board tile, which is the one difference nobody would see until a
-- team had already ground the cheapest drop fifteen times.

create or replace function admin_autofill_board(p_game_id uuid, p_tag text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_game   games%rowtype;
  v_result jsonb;
begin
  if not is_admin() then raise exception 'Admins only'; end if;

  select * into v_game from games where id = p_game_id;
  if not found then raise exception 'No such game'; end if;
  if v_game.status not in ('setup', 'placement') then
    raise exception 'Tiles are locked once the game is %', v_game.status;
  end if;

  with empty as materialized (
    select r.n::smallint as "row", c.n::smallint as col,
           row_number() over (order by random()) as slot
      from generate_series(1, v_game.grid_size) as r(n)
      cross join generate_series(1, v_game.grid_size) as c(n)
     where not exists (
             select 1 from tiles t
              where t.game_id = p_game_id and t.row = r.n and t.col = c.n)
  ),

  taken as materialized (
    select tile_name_key(t.name) as name_key,
           tile_task_key(t.name) as task_key
      from tiles t where t.game_id = p_game_id
  ),

  pool as materialized (
    select l.id, tile_task_key(l.name) as task_key
      from tile_library l
     where tile_name_key(l.name) not in (select name_key from taken)
       and (p_tag is null or l.tags @> array[p_tag])
       and not (l.completion in ('one_set', 'each_set')
                and not exists (select 1 from tile_library_options o
                                 where o.library_id = l.id))
       and not (l.completion = 'value'
                and exists (select 1 from tile_library_options o
                             where o.library_id = l.id))
  ),

  first_choice as materialized (
    select distinct on (p.task_key) p.id
      from pool p
     where p.task_key not in (select task_key from taken)
     order by p.task_key, random()
  ),

  ranked as materialized (
    select f.id, 0 as tier, row_number() over (order by random()) as ord
      from first_choice f
    union all
    select p.id, 1 as tier, row_number() over (order by random()) as ord
      from pool p
     where p.id not in (select id from first_choice)
  ),
  chosen as materialized (
    select r.id, r.tier, row_number() over (order by r.tier, r.ord) as slot
      from ranked r
  ),

  plan as materialized (
    select e."row", e.col, c.id as library_id, c.tier
      from empty e join chosen c on c.slot = e.slot
  ),

  ins as (
    insert into tiles (game_id, "row", col, name, icon, required_evidence,
                       description, completion, per_set, library_id)
    select p_game_id, pl."row", pl.col, l.name, l.icon, l.required_evidence,
           l.description, l.completion, l.per_set, l.id
      from plan pl join tile_library l on l.id = pl.library_id
    returning id, library_id
  ),

  opts as (
    insert into tile_options (tile_id, label, points, sort, grp, max_times)
    select i.id, o.label, o.points, o.sort, o.grp, o.max_times
      from ins i join tile_library_options o on o.library_id = i.library_id
    returning 1
  ),
  bumped as (
    update tile_library l
       set times_used = l.times_used + 1, last_used_at = now()
      from ins i where l.id = i.library_id
    returning 1
  )
  select jsonb_build_object(
           'filled',  (select count(*) from plan),
           'similar', (select count(*) from plan where tier = 1),
           'empty',   (select count(*) from empty),
           'pool',    (select count(*) from pool)
         )
    into v_result;

  return v_result;
end;
$$;

revoke execute on function admin_autofill_board(uuid, text) from public, anon;
grant  execute on function admin_autofill_board(uuid, text) to authenticated;
