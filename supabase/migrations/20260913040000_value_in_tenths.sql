-- Half a million
--
-- A `value` tile is scored on what the submitter says the drop was worth, and
-- until now that number was a whole million: `p_amount` was checked as 1..1000
-- and `tile_evidence.points` is an integer column. That held for the tiles it
-- was written for -- 250m in raid uniques, 50m in clue loot -- and broke on the
-- first tile with something cheap on the list.
--
-- "15M worth of Revenant emblems" is that tile. A revenant Ancient emblem is
-- worth exactly 500,000; every artefact above it doubles, up to the relic at
-- 16m. With whole millions the emblem cannot be counted at all, and the tile
-- said so in its own description -- "Ancient emblems worth 0.5m do not count"
-- -- which is a rule invented to fit the storage rather than the game.
--
-- So the unit is now a TENTH of a million, for every value tile: `p_amount`,
-- `tile_evidence.points`, and `required_evidence` on both `tiles` and
-- `tile_library`. Nothing stored is a fraction -- 0.5m is 5, 15m is 150, 250m
-- is 2500 -- and nothing player-facing changes, because every screen that
-- prints one of these numbers divides it back (web/src/lib/millions.js, and
-- `value_m` below for the Discord relay).
--
-- A tenth rather than a hundredth: it covers the half million that prompted
-- this and every tier above it, and keeps a 1000m target inside `smallint`
-- with room to spare. If a tile ever needs 50k precision, the unit is defined
-- in two places -- here and millions.js -- and nowhere else.
--
-- WHAT MOVES. Section 6 multiplies every existing value tile by ten: three
-- catalogue entries, their squares on three boards, the evidence already
-- submitted against them, and the copies inside saved board presets. It is NOT
-- idempotent. It is written as one statement per table inside a migration that
-- runs once; do not re-run it by hand against a database that has had it.
--
-- WHAT DOES NOT MOVE. `points` tiles, set tiles, and every option price. The
-- unit belongs to the value rule alone, which is why the clamp in sections 4
-- and 5 asks the completion rule before choosing a ceiling.
--
-- THE HALVES ARE DANGEROUS APART. The client half of this change reads every
-- value tile at a tenth of its target without this migration; this migration
-- without the client makes a typed 15 arrive as 15 and score 1.5m. They ship
-- together.

-- ============================================================
-- 1. Tenths, said in millions
-- ============================================================
-- Whole numbers stay whole: a 250m tile must not start reading "250.0m" in
-- Discord because of a change that has nothing to do with it.

create or replace function value_m(p_tenths int)
returns text
language sql immutable set search_path = public as $$
  select case
           when p_tenths is null  then '0'
           when p_tenths % 10 = 0 then (p_tenths / 10)::text
           else trim(to_char(p_tenths / 10.0, 'FM999999990.0'))
         end;
$$;

comment on function value_m(int) is
  'A value tile''s tenths-of-a-million as a millions string: 5 -> 0.5, 150 -> 15.';

-- ============================================================
-- 2. The submission
-- ============================================================
-- Unchanged but for the range, which is now in tenths.

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
  v_opt_label text;
  v_award     int := 1;
  v_sets      boolean;
  v_refuse    text;
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

  if v_tile.completion = 'value' then
    if p_option_id is not null then
      raise exception 'This tile is scored on the value you enter, not on a drop list';
    end if;
    if p_amount is null then
      raise exception 'Say what this drop was worth';
    end if;
    -- Tenths of a million, so this is 0.1m to 1000m. The message is in the
    -- millions the player typed, not in the unit it arrived as.
    if p_amount < 1 or p_amount > 10000 then
      raise exception 'That value must be between 0.1m and 1000m';
    end if;
    v_award := p_amount;

  else
    if p_amount is not null then
      raise exception 'This tile is not scored on a typed value';
    end if;

    if p_option_id is not null then
      if not v_has_opts then
        raise exception 'This tile has no drop options to choose from';
      end if;
      select * into v_opt from tile_options
       where id = p_option_id and tile_id = v_tile.id;
      if not found then raise exception 'That is not one of this tile''s options'; end if;

      v_refuse := evidence_refusal(p_claim_id, p_option_id);
      if v_refuse is not null then raise exception '%', v_refuse; end if;

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
-- 3. The broadcast line
-- ============================================================

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
          -- Every number on a value tile is stored in tenths of a million.
          format('**%s** submitted a drop worth **%sm** for **%s** (%s/%sm).',
                 v_who, value_m((p_event.payload ->> 'points_awarded')::int),
                 coalesce(p_event.payload ->> 'tile_name', 'a tile'),
                 value_m((p_event.payload ->> 'points_total')::int),
                 value_m((p_event.payload ->> 'required_evidence')::int))
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

-- ============================================================
-- 4. Saving a square
-- ============================================================

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

  if v_game.status not in ('setup', 'placement', 'active') then
    raise exception 'Tiles are locked once the game is %', v_game.status;
  end if;

  -- Mid-game, only a square nobody has locked in. See the header.
  if v_game.status = 'active' and exists (
       select 1
         from tile_claims c
         join tiles t on t.id = c.tile_id
        where t.game_id = p_game_id and t."row" = p_row and t.col = p_col
     ) then
    raise exception
      'A team has locked that square in — release the claim first, or wait for it to fire';
  end if;

  if p_row < 1 or p_row > v_game.grid_size or p_col < 1 or p_col > v_game.grid_size then
    raise exception 'Square %,% is off a %x% board',
      p_row, p_col, v_game.grid_size, v_game.grid_size;
  end if;

  v_completion := coalesce(nullif(btrim(coalesce(p_tile ->> 'rule', '')), ''),
                           'points')::tile_completion;
  -- A value tile's target is in tenths of a million; every other rule's is a
  -- small count. The ceiling is the same 1000m it always was, said in the unit
  -- the column now holds -- without this a 250m tile saves as 100m.
  v_amount := least(greatest(coalesce((nullif(btrim(p_tile ->> 'amount'), ''))::int, 1), 1),
                    case when v_completion = 'value' then 10000 else 1000 end);
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
  -- Safe precisely because the square above is guaranteed unclaimed, so there
  -- is no `tile_evidence` pointing at any of these rows.
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
-- 5. Saving a catalogue entry
-- ============================================================

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
  -- A value tile's target is in tenths of a million; every other rule's is a
  -- small count. The ceiling is the same 1000m it always was, said in the unit
  -- the column now holds -- without this a 250m tile saves as 100m.
  v_amount := least(greatest(coalesce((nullif(btrim(p_tile ->> 'amount'), ''))::int, 1), 1),
                    case when v_completion = 'value' then 10000 else 1000 end);
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


-- ============================================================
-- 6. The ceilings on the columns themselves
-- ============================================================
-- Each of these caps was "1000m" written in the old unit, and each still means
-- 1000m -- said in tenths. Without them section 7 cannot land: a 250m tile
-- becoming 2500 is rejected by the very constraint that used to allow it.
--
-- `tile_evidence.points` is shared with every other rule, where a single
-- screenshot is worth at most 30. Widening the bound does not loosen anything
-- that matters there: what a drop is worth is decided by `tile_options.points`
-- and clamped to 30 when the tile is saved, and this column only ever receives
-- what add_evidence computed.

alter table tiles
  drop constraint if exists tiles_required_evidence_check,
  add  constraint tiles_required_evidence_check
       check (required_evidence >= 1 and required_evidence <= 10000);

alter table tile_library
  drop constraint if exists tile_library_required_evidence_check,
  add  constraint tile_library_required_evidence_check
       check (required_evidence >= 1 and required_evidence <= 10000);

alter table tile_evidence
  drop constraint if exists tile_evidence_points_check,
  add  constraint tile_evidence_points_check
       check (points >= 1 and points <= 10000);

-- ============================================================
-- 7. Ten times what is already there
-- ============================================================
-- Three catalogue entries and the squares dealt from them, the evidence
-- already submitted against those squares, and the copies inside saved board
-- presets. Run once, by this migration. See the header.
--
-- Order does not matter -- these are four independent tables and the migration
-- is one transaction -- but evidence is done before the presets so that a
-- failure in the JSONB rewrite, the fiddliest of the four, rolls the lot back
-- rather than leaving targets and evidence disagreeing.

update tiles
   set required_evidence = (required_evidence * 10)::smallint
 where completion = 'value';

update tile_library
   set required_evidence = (required_evidence * 10)::smallint
 where completion = 'value';

update tile_evidence e
   set points = e.points * 10
  from tile_claims c
  join tiles t on t.id = c.tile_id
 where c.id = e.claim_id
   and t.completion = 'value';

-- A preset square is `{row, col, tile: {...}}` and the target lives at
-- `tile.amount`, alongside the rule that says what unit it is in. Squares that
-- are not value tiles are rebuilt unchanged rather than skipped, because the
-- whole array is replaced in one go.
update board_presets p
   set squares = coalesce((
         select jsonb_agg(
                  case when s -> 'tile' ->> 'rule' = 'value'
                            and (s -> 'tile' ->> 'amount') is not null
                       then jsonb_set(s, '{tile,amount}',
                                      to_jsonb(((s -> 'tile' ->> 'amount')::int) * 10))
                       else s end
                  order by ord)
           from jsonb_array_elements(p.squares) with ordinality as e(s, ord)
       ), p.squares)
 where jsonb_typeof(p.squares) = 'array'
   and exists (
         select 1 from jsonb_array_elements(p.squares) s
          where s -> 'tile' ->> 'rule' = 'value');

-- ============================================================
-- 8. The tester speaks the same unit
-- ============================================================
-- `admin_test_tile` plays picks through the real `claim_is_complete()`, which
-- is what makes it worth trusting -- but its own value branch carried the old
-- bounds and the old label. It would have refused an amount over 100m that
-- `add_evidence` accepts, and printed half a million as "5m". The one tool
-- whose job is to catch the two copies of the rules drifting apart must not be
-- the thing that drifts.

create or replace function admin_test_tile(p_tile_id uuid, p_picks jsonb default '[]'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tile   tiles%rowtype;
  v_team   uuid;
  v_claim  uuid;
  v_steps  jsonb := '[]'::jsonb;
  v_done   boolean := false;
  v_at     int;
  v_total  int := 0;
  v_count  int := 0;
  v_n      int := 0;
  v_pick   jsonb;
  v_opt    tile_options%rowtype;
  v_award  int;
  v_refuse text;
  v_label  text;
  v_error  text;
begin
  if not is_admin() then raise exception 'Admins only'; end if;

  select * into v_tile from tiles where id = p_tile_id;
  if not found then raise exception 'No such tile'; end if;

  -- Any team in the game will do: nothing here is scored against them and none
  -- of it survives the block. A game with no teams yet has nothing to hang a
  -- claim on, which is worth saying plainly rather than failing on a not-null.
  select id into v_team from teams where game_id = v_tile.game_id
   order by slot nulls last, created_at limit 1;
  if v_team is null then
    raise exception 'This game has no teams yet, so there is nothing to test a claim against';
  end if;

  begin
    insert into tile_claims (tile_id, team_id, status)
    values (p_tile_id, v_team, 'active')
    returning id into v_claim;

    for v_pick in
      select value from jsonb_array_elements(
        case when jsonb_typeof(p_picks) = 'array' then p_picks else '[]'::jsonb end)
    loop
      v_n     := v_n + 1;
      v_opt   := null;
      v_refuse := null;
      v_award := 1;

      if v_tile.completion = 'value' then
        v_award := coalesce((nullif(btrim(v_pick ->> 'amount'), ''))::int, 0);
        -- Tenths of a million, and the same bounds add_evidence enforces. Both
        -- halves of this mattered: the old ceiling refused anything over 100m
        -- that a player could really submit, and the old label called half a
        -- million "5m".
        v_label := value_m(v_award) || 'm';
        if v_award < 1 or v_award > 10000 then
          v_refuse := 'That value must be between 0.1m and 1000m';
        end if;

      elsif exists (select 1 from tile_options where tile_id = p_tile_id) then
        select * into v_opt from tile_options
         where id = (nullif(btrim(v_pick ->> 'option_id'), ''))::uuid
           and tile_id = p_tile_id;
        if not found then
          v_label  := '(no drop chosen)';
          v_refuse := 'Say which drop this screenshot shows';
        else
          v_label  := v_opt.label;
          v_refuse := evidence_refusal(v_claim, v_opt.id);
          v_award  := case when v_tile.completion in ('one_set', 'each_set')
                           then 1 else v_opt.points end;
        end if;

      else
        -- A plain tile banks a point per screenshot and asks nothing else.
        v_label := 'Screenshot';
      end if;

      if v_refuse is null then
        insert into tile_evidence (claim_id, team_id, storage_path,
                                   uploaded_by_name, option_id, points)
        values (v_claim, v_team, 'dry-run/' || v_n, 'tile test',
                case when v_opt.id is null then null else v_opt.id end, v_award);
        v_total := v_total + v_award;
        v_count := v_count + 1;
        if not v_done and claim_is_complete(v_claim) then
          v_done := true;
          v_at   := v_n;
        end if;
      end if;

      v_steps := v_steps || jsonb_build_object(
        'n',        v_n,
        'label',    v_label,
        'awarded',  case when v_refuse is null then v_award else 0 end,
        'total',    v_total,
        'count',    v_count,
        'complete', v_done,
        'refused',  v_refuse
      );
    end loop;

    -- Unwinds everything above. See the note on this function.
    raise exception 'dry run complete' using errcode = 'HS001';

  exception
    when sqlstate 'HS001' then
      null;
    when others then
      -- A trigger said no -- the active-claim limit, most likely, if this game
      -- is under way and the chosen team already has its hands full. Reported
      -- rather than thrown, so the builder can say which part failed.
      v_error := sqlerrm;
  end;

  return jsonb_build_object(
    'rule',              v_tile.completion::text,
    'required',          coalesce(v_tile.required_evidence, 1),
    'per_set',           v_tile.per_set,
    'priced',            exists (select 1 from tile_options where tile_id = p_tile_id),
    'complete',          v_done,
    'completed_at_step', v_at,
    'points_total',      v_total,
    'accepted',          v_count,
    'steps',             v_steps,
    'error',             v_error
  );
end;
$$;

revoke execute on function admin_test_tile(uuid, jsonb) from public, anon;
grant  execute on function admin_test_tile(uuid, jsonb) to authenticated;

