-- Two uniques from each boss, where two of the same unique also count.
--
-- 0049 built three set rules on one idea: an option may name a GROUP, and a
-- group is finished by which DISTINCT options are in it. That distinctness is
-- the whole point of `each_set` — "two different purples from each raid" is a
-- tile precisely because two of the same purple must not finish it.
--
-- But the V4 board also asks for "two uniques from each GWD boss", and there
-- the organiser means two DROPS, not two different drops: a team that gets two
-- Bandos chestplates has done what the tile asked. Under `each_set` that
-- group is stuck at one forever. The board had been working around it with an
-- extra fake option per group — "any second Graardor unique (duplicate)" —
-- which is a lie told to the picker, and reads like one.
--
-- So: a fourth rule. `points_per_set` groups its drops exactly as `each_set`
-- does, but a group is finished when the POINTS handed into it reach `per_set`
-- rather than when that many distinct options are in — which means the same
-- drop, submitted twice, counts twice. With every option worth 1 that reads as
-- "any two drops from this boss"; with prices on the options it reads as "this
-- much value from each boss", which nothing else expresses either.
--
-- Nothing existing changes. `each_set` keeps counting distinct options, and
-- every tile already saved keeps the rule it was saved with.

-- ============================================================
-- 1. The rule needs its drops, like the other set rules
-- ============================================================
-- Both `admin_set_tile` and `admin_save_library_tile` ask this one function,
-- so teaching it here is all either of them needs.

create or replace function assert_tile_rule_ok(
  p_completion tile_completion,
  p_options    integer,
  p_what       text default 'This tile'
) returns void
language plpgsql immutable set search_path = public as $$
begin
  if p_completion in ('one_set', 'each_set', 'points_per_set') and p_options = 0 then
    raise exception '% needs the drops that make up its sets', p_what;
  end if;
  if p_completion = 'value' and p_options > 0 then
    raise exception '% is scored on typed value and cannot also list drops', p_what;
  end if;
end;
$$;

-- ============================================================
-- 2. When such a tile is finished
-- ============================================================
-- The `each_set` branch is untouched beside it, which is the point: the two
-- rules differ in exactly one clause. `each_set` counts option rows that have
-- ANY evidence (`count(*) filter (where exists ...)`); this sums the POINTS of
-- the evidence rows themselves, so a second screenshot of the same drop adds
-- to the total instead of being absorbed by an `exists`.
--
-- No `least(per_set, total)` cap here, unlike `each_set`. That cap exists
-- because a group of one cannot yield two DISTINCT options and would lock the
-- tile forever; with repeats counting, a group of one can reach any target, so
-- capping would instead finish groups that had not been finished.

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

  -- Both DISTINCT-set rules count options, not rows: `exists` rather than a
  -- count, so handing in the same piece twice moves nothing. A tile with no
  -- options at all can never satisfy either rule, and returns false rather
  -- than vacuously true — hence the `exists` guard on each_set, where "every
  -- group has enough" is otherwise true of no groups.
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
      -- satisfy and would lock the tile forever.
      where s.have < least(v_tile.per_set, s.total)
    );
  end if;

  if v_tile.completion = 'points_per_set' then
    return exists (select 1 from tile_options where tile_id = v_tile.id)
       and not exists (
      select 1 from (
        select coalesce(o.grp, o.label) as g,
               sum((select coalesce(sum(e.points), 0)
                      from tile_evidence e
                     where e.claim_id = p_claim_id and e.option_id = o.id)) as have
          from tile_options o
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

-- `add_evidence` needs no change, and that is worth saying out loud since it
-- is the one place a new rule could plausibly have needed one. Its `v_sets`
-- flag does two jobs — refuse a repeat, and flatten the award to 1 — and a
-- `points_per_set` tile wants neither: the repeat is the feature, and the
-- award is the option's own price. Falling through to the `points` path gives
-- exactly that, so the rule is served by the code that was already there.

-- ============================================================
-- 3. How many of each drop this team has in
-- ============================================================
-- `taken` — a boolean — was enough while every set rule counted options. It
-- cannot say "two Bandos chestplates", so the card could not draw a group as
-- 2/2 under the new rule, and the picker could not know a group had filled.
-- `got` carries the count alongside it; `taken` stays for everything reading
-- it today.
--
-- Same signature, so `create or replace` and no regrant. The redaction is
-- unchanged: `options` is still null for any tile this team has not claimed.

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
                        'grp', o.grp,
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
-- 4. The broadcast line
-- ============================================================
-- Named alongside the other set rules rather than with `points`. A running
-- "6/10" is what the points branch prints, and on a tile whose target is
-- per-group that total is not a fraction of anything — so this says which drop
-- came in and stops, exactly as `each_set` does.

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
        when v_rule in ('one_set', 'each_set', 'points_per_set') and v_opt is not null then
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

comment on column tiles.per_set is
  'For `each_set`: how many distinct options each group needs. For '
  '`points_per_set`: how many points each group needs, repeats counting. '
  'Ignored otherwise.';
