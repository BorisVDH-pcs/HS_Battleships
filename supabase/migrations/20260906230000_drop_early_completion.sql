-- Early completion, removed.
--
-- (No tile text in this file: this repo is public and the tile contents are
-- secret #2. Shapes described in the abstract, as in 0025, 0046 and 0049.)
--
-- 0025 added `early_complete` for one reason, stated there: some tiles have
-- several routes to done at different costs, `required_evidence` could only
-- count screenshots, so the tile was priced at its WORST case and the team got
-- a self-declared "we are done" button. The organiser could not tell a genuine
-- short route from an optimistic one, and the number on the card was a count
-- nobody was working toward.
--
-- 0046 and 0049 removed the reason.
--
--   * A multi-route tile is a `points` tile with priced drops: three of this,
--     nine of that or eighteen of the other are one target reached three ways,
--     and every route finishes it exactly.
--   * "One full set out of several" is `one_set`, and its worst case was the
--     pigeonhole count 0025 was really apologising for.
--   * "One from each of these" is `each_set`.
--   * "This much GP" is `value`, where the team types the figure.
--
-- Each of those says precisely when the tile is done, so 0046 refused early
-- completion on a priced tile and 0049 refused it on the set and value rules.
-- What survived was the intersection: a `points` tile with NO priced drops --
-- which is a plain "N screenshots of this" tile, the one shape that has a
-- single unambiguous route, and exactly the case 0025 said must NOT get the
-- button. The feature could only be reached where it was never meant to apply.
--
-- The V4 board bears that out: 100 tiles, 90 points, 3 one_set, 5 each_set,
-- 2 value, and the ten multi-route tiles rewritten under 0049. Not one of them
-- is flagged, and no claim in the database has ever been declared early.
--
-- What IS still flagged, checked against production before writing this: nine
-- tiles on the 2026-08-30 demo board, which predates 0046 entirely and has no
-- priced drop on it at all, plus the four catalogue entries imported from that
-- board (`times_used` 4, on no other board). Those nine revert to the plain
-- worst-case count they were always priced at, which is the same thing that
-- would happen if the organiser cleared the flag by hand. Deliberate: keeping a
-- feature alive for a demo board is not a reason to keep it.
--
-- So `complete_tile_early()` goes, the trigger's second route to `fired` goes,
-- and `tiles.early_complete` / `tile_claims.completed_early` /
-- `tile_library.early_complete` go with them. Every function that carried the
-- column through is rebuilt without it -- unchanged otherwise.
--
-- What is lost: `tile_claims.completed_early` recorded which shots were
-- self-declared. Nothing ever read it -- it appears in no read function, no
-- feed line and no admin screen -- and since 0046/0049 no tile could set it.
--
-- `enforce_evidence_before_fire` is left with ONE route to a fired claim, which
-- is what 0021 and 0023 had before 0025 opened the second one: a claim that is
-- `fired` is a claim `claim_is_complete()` agreed was finished.

-- ============================================================
-- 1. The self-declared shot
-- ============================================================

drop function if exists complete_tile_early(uuid);

-- ============================================================
-- 2. The guard on the table, with one route through it
-- ============================================================

create or replace function enforce_evidence_before_fire() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.status <> 'fired' or old.status = 'fired' then
    return new;
  end if;

  if not claim_is_complete(new.id) then
    raise exception 'This tile is not finished yet';
  end if;

  return new;
end;
$$;


-- ============================================================
-- 3. The board a team can see
-- ============================================================
-- A RETURNS TABLE change, so a drop, rebuild and regrant. Miss the regrant and
-- every player loses the board (0014 learned this the hard way).

drop function if exists tiles_for_me(uuid);

create function tiles_for_me(p_game_id uuid)
returns table (
  id uuid, game_id uuid, "row" smallint, col smallint, "position" smallint,
  revealed boolean, name text, icon text,
  required_evidence smallint, evidence_count integer,
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
-- 4. The organiser's own board
-- ============================================================

drop function if exists admin_list_tiles(uuid);

create function admin_list_tiles(p_game_id uuid)
returns table (id uuid, "row" smallint, col smallint, "position" smallint,
               name text, icon text, required_evidence smallint,
               options jsonb, description text,
               completion text, per_set smallint, library_id uuid)
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  return query
    select t.id, t.row, t.col, t.position, t.name, t.icon,
           t.required_evidence,
           (select coalesce(jsonb_agg(jsonb_build_object(
                     'id', o.id, 'label', o.label, 'points', o.points, 'grp', o.grp
                   ) order by o.sort, o.label), '[]'::jsonb)
              from tile_options o where o.tile_id = t.id),
           t.description, t.completion::text, t.per_set, t.library_id
      from tiles t where t.game_id = p_game_id order by t.position;
end;
$$;

revoke execute on function admin_list_tiles(uuid) from public, anon;
grant  execute on function admin_list_tiles(uuid) to authenticated;


-- ============================================================
-- 5. The catalogue
-- ============================================================

drop function if exists admin_list_library();

create function admin_list_library()
returns table (id uuid, name text, icon text, description text,
               required_evidence smallint,
               completion text, per_set smallint, tags text[],
               times_used integer, last_used_at timestamptz, options jsonb)
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  return query
    select l.id, l.name, l.icon, l.description,
           l.required_evidence,
           l.completion::text, l.per_set, l.tags,
           l.times_used, l.last_used_at,
           (select coalesce(jsonb_agg(jsonb_build_object(
                     'label', o.label, 'points', o.points, 'grp', o.grp
                   ) order by o.sort, o.label), '[]'::jsonb)
              from tile_library_options o where o.library_id = l.id)
      from tile_library l
     order by l.times_used desc, l.last_used_at desc nulls last, l.name;
end;
$$;

revoke execute on function admin_list_library() from public, anon;
grant  execute on function admin_list_library() to authenticated;


-- ============================================================
-- 6. Everything that wrote the column
-- ============================================================
-- Five functions, each losing one column from an insert and -- where it has one
-- -- the matching line from its ON CONFLICT. No other change: they are
-- reproduced whole from 0049/0050/0051 so the next reader diffs one idea rather
-- than hunting three files for the current body.


create or replace function admin_save_library_tile(p_id uuid, p_tile jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id         uuid;
  v_completion tile_completion;
  v_options    int;
  v_name       text;
begin
  if not is_admin() then raise exception 'Admins only'; end if;

  v_name := btrim(coalesce(p_tile ->> 'name', ''));
  if v_name = '' then raise exception 'A library tile needs a name'; end if;

  v_completion := coalesce(nullif(btrim(coalesce(p_tile ->> 'rule', '')), ''),
                           'points')::tile_completion;
  v_options := (
    select count(*)
      from jsonb_array_elements(
             case when jsonb_typeof(p_tile -> 'options') = 'array'
                  then p_tile -> 'options' else '[]'::jsonb end) o
     where btrim(coalesce(o ->> 'label', '')) <> ''
  );
  perform assert_tile_rule_ok(v_completion, v_options, format('%L', v_name));

  begin
    insert into tile_library (id, name, icon, description, required_evidence,
                              completion, per_set, tags, created_by)
    values (
      coalesce(p_id, gen_random_uuid()),
      left(v_name, 120),
      nullif(regexp_replace(btrim(coalesce(p_tile ->> 'icon', '')),
                            '[^A-Za-z0-9_-]', '', 'g'), ''),
      nullif(left(btrim(coalesce(p_tile ->> 'description', '')), 500), ''),
      least(greatest(coalesce((nullif(btrim(p_tile ->> 'amount'), ''))::int, 1), 1), 1000),
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

  insert into tile_library_options (library_id, label, points, sort, grp)
  select v_id,
         left(btrim(o.val ->> 'label'), 80),
         least(greatest(coalesce((o.val ->> 'points')::smallint, 1), 1), 30),
         (o.ord - 1)::smallint,
         nullif(left(btrim(coalesce(o.val ->> 'grp', '')), 40), '')
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


create or replace function admin_import_board_to_library(p_game_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_added   int;
  v_total   int;
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if not exists (select 1 from games where id = p_game_id) then
    raise exception 'No such game';
  end if;

  select count(*) into v_total from tiles where game_id = p_game_id;

  -- One statement, so `inserted` is the count of entries actually created --
  -- no second pass guessing at which rows were new. `opts` is never selected
  -- from; a data-modifying CTE runs whether or not anything reads it.
  with fresh as (
    -- The board's own duplicates are collapsed here too, or two squares
    -- sharing a name would race for the same key inside this one statement.
    select distinct on (tile_name_key(t.name)) t.*,
           left(btrim(t.name), 120) as lib_name
      from tiles t
     where t.game_id = p_game_id
       and btrim(t.name) <> ''
       and not exists (
         select 1 from tile_library l
          where tile_name_key(l.name) = tile_name_key(t.name)
       )
     order by tile_name_key(t.name), t.position
  ), inserted as (
    insert into tile_library (name, icon, description, required_evidence,
                              completion, per_set, created_by)
    select f.lib_name, f.icon, f.description, f.required_evidence,
           f.completion, f.per_set, auth.uid()
      from fresh f
    returning id, name
  ), opts as (
    -- Joined back on the name, because `inserted` cannot see which tile each
    -- new row came from. Safe because `fresh` is already one row per name.
    insert into tile_library_options (library_id, label, points, sort, grp)
    select i.id, o.label, o.points, o.sort, o.grp
      from inserted i
      join fresh f on tile_name_key(f.lib_name) = tile_name_key(i.name)
      join tile_options o on o.tile_id = f.id
    returning 1
  )
  select count(*)::int into v_added from inserted;

  return jsonb_build_object('added',   v_added,
                            'skipped', v_total - v_added,
                            'total',   v_total);
end;
$$;

revoke execute on function admin_import_board_to_library(uuid) from public, anon;
grant  execute on function admin_import_board_to_library(uuid) to authenticated;


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
  v_options := (
    select count(*)
      from jsonb_array_elements(
             case when jsonb_typeof(p_tile -> 'options') = 'array'
                  then p_tile -> 'options' else '[]'::jsonb end) o
     where btrim(coalesce(o ->> 'label', '')) <> ''
  );
  perform assert_tile_rule_ok(v_completion, v_options, 'This tile');

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
    least(greatest(coalesce((nullif(btrim(p_tile ->> 'amount'), ''))::int, 1), 1), 1000),
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

  insert into tile_options (tile_id, label, points, sort, grp)
  select v_tile_id,
         left(btrim(o.val ->> 'label'), 80),
         least(greatest(coalesce((o.val ->> 'points')::smallint, 1), 1), 30),
         (o.ord - 1)::smallint,
         nullif(left(btrim(coalesce(o.val ->> 'grp', '')), 40), '')
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


create or replace function admin_set_tiles(p_game_id uuid, p_tiles jsonb)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_game  games%rowtype;
  v_count int;
  v_bad   record;
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
                     description, completion, per_set)
  select p_game_id,
         (t ->> 'row')::smallint,
         (t ->> 'col')::smallint,
         coalesce(nullif(btrim(t ->> 'name'), ''), 'Tile'),
         nullif(regexp_replace(btrim(coalesce(t ->> 'icon', '')),
                               '[^A-Za-z0-9_-]', '', 'g'), ''),
         least(greatest(coalesce((nullif(btrim(t ->> 'amount'), ''))::int, 1), 1), 1000),
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
  for v_bad in
    select t.completion as completion, count(o.id) as options
      from tiles t
      left join tile_options o on o.tile_id = t.id
     where t.game_id = p_game_id
     group by t.id, t.completion
  loop
    perform assert_tile_rule_ok(v_bad.completion, v_bad.options::int, 'A tile');
  end loop;

  return v_count;
end;
$$;

revoke execute on function admin_set_tiles(uuid, jsonb) from public, anon;
grant  execute on function admin_set_tiles(uuid, jsonb) to authenticated;


create or replace function admin_autofill_board(p_game_id uuid)
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

  -- One statement, so a board is never half-dealt. Every CTE that uses
  -- random() is `materialized`: an inlined CTE referenced twice would be
  -- evaluated twice, and two different shuffles would put a tile in one place
  -- and its drops in another.
  with empty as materialized (
    select r.n::smallint as "row", c.n::smallint as col,
           row_number() over (order by random()) as slot
      from generate_series(1, v_game.grid_size) as r(n)
      cross join generate_series(1, v_game.grid_size) as c(n)
     where not exists (
             select 1 from tiles t
              where t.game_id = p_game_id and t.row = r.n and t.col = c.n)
  ),

  -- What the board already holds. Both keys, because a tile already placed
  -- rules out its own entry outright and makes its task merely undesirable.
  taken as materialized (
    select tile_name_key(t.name) as name_key,
           tile_task_key(t.name) as task_key
      from tiles t where t.game_id = p_game_id
  ),

  -- Everything the shuffle is allowed to deal. The rule check is defensive
  -- rather than expected: `admin_save_library_tile` refuses a set tile with no
  -- drops, so one should not exist -- but a board dealt from a broken entry
  -- would be a tile no team could ever finish, discovered mid-event, and the
  -- cost of not dealing it is that a square stays empty for someone to notice.
  pool as materialized (
    select l.id, tile_task_key(l.name) as task_key
      from tile_library l
     where tile_name_key(l.name) not in (select name_key from taken)
       and not (l.completion in ('one_set', 'each_set')
                and not exists (select 1 from tile_library_options o
                                 where o.library_id = l.id))
       and not (l.completion = 'value'
                and exists (select 1 from tile_library_options o
                             where o.library_id = l.id))
  ),

  -- The preferred tier: one entry per task, and no task the board already has.
  -- `distinct on` with a random tiebreak means which variant of a task gets
  -- dealt is itself a shuffle, rather than always the alphabetically first.
  first_choice as materialized (
    select distinct on (p.task_key) p.id
      from pool p
     where p.task_key not in (select task_key from taken)
     order by p.task_key, random()
  ),

  -- Tier 1 is everything else -- the variants that lost the draw above, and the
  -- tasks the board already has in another form. They are dealt only after the
  -- distinct ones run out, which is what "similar tasks may share a board, but
  -- only if that is what it takes to fill it" means in practice.
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

  -- An inner join, so a catalogue too small for the board fills what it can and
  -- leaves the rest empty rather than failing. Ninety-two squares dealt and
  -- eight to think about is a useful evening; an error message is not.
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

  -- Safe to join on `library_id` because the pool excluded every name the board
  -- already had and deals each entry at most once, so among these rows the id
  -- identifies exactly one square.
  opts as (
    insert into tile_options (tile_id, label, points, sort, grp)
    select i.id, o.label, o.points, o.sort, o.grp
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

revoke execute on function admin_autofill_board(uuid) from public, anon;
grant  execute on function admin_autofill_board(uuid) to authenticated;


-- ============================================================
-- 7. The columns
-- ============================================================
-- Last, so every function above already reads a shape that does not include
-- them. `if exists` on each, because this file must survive being applied to a
-- database that has already had it.

alter table tiles        drop column if exists early_complete;
alter table tile_claims  drop column if exists completed_early;
alter table tile_library drop column if exists early_complete;
