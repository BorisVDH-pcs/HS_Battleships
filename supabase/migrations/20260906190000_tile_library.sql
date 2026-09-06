-- ============================================================
-- A reusable tile library, and boards built one square at a time
-- ============================================================
-- Until now a board was a single 100-line paste: `admin_set_tiles` deleted every
-- tile for the game and re-inserted the lot, so there was no such thing as
-- editing one square, and nothing survived the event it was written for. Three
-- games in, the same tasks are being retyped every time.
--
-- Two changes, and they are separable:
--
--   1. `tile_library` is a game-independent catalogue of tile definitions. Same
--      shape as a tile, minus the coordinate -- a library entry is *what the
--      task is*, a tile is that task at G7 of one game.
--   2. `admin_set_tile` / `admin_clear_tile` write one square. The paste box
--      stays: it is still the fastest way to load a board that already exists
--      as text, and `tileParser.js` remains the single grammar authority. The
--      builder writes the same row shape the parser emits.
--
-- A partial board was already legal -- `admin_list_tiles` counts whatever is
-- there and `start_game` refuses below grid_size^2 -- so nothing downstream
-- has to learn about half-built boards.

-- ============================================================
-- 1. The catalogue
-- ============================================================

create table if not exists tile_library (
  id                uuid        primary key default gen_random_uuid(),
  name              text        not null check (btrim(name) <> ''),
  icon              text,
  description       text,
  -- Mirrors `tiles` exactly, so an entry can be copied into a square without
  -- translation. The bounds are the ones 0049 widened to.
  required_evidence smallint    not null default 1
                    check (required_evidence between 1 and 1000),
  early_complete    boolean     not null default false,
  completion        tile_completion not null default 'points',
  per_set           smallint    not null default 1 check (per_set between 1 and 30),
  tags              text[]      not null default '{}',
  -- Sorting the picker by what actually gets used beats sorting it
  -- alphabetically once the catalogue is bigger than one screen.
  times_used        integer     not null default 0,
  last_used_at      timestamptz,
  created_at        timestamptz not null default now(),
  created_by        uuid        references profiles(id) on delete set null
);

-- Name is the library's identity. Importing the same board twice, or two boards
-- that share a task, must not produce two entries to choose between in the
-- picker -- the whole point is one row per task. Case- and space-insensitive,
-- because `Barrows set` and `barrows  set` are the same tile to a human.
-- Named rather than inlined so the import below can ask "is this task already
-- in here" with exactly the expression the index enforces, instead of a second
-- copy of the rule that could drift from it.
create or replace function tile_name_key(p_name text)
returns text language sql immutable strict set search_path = public as $fn$
  select lower(regexp_replace(btrim(p_name), '\s+', ' ', 'g'));
$fn$;

create unique index if not exists tile_library_name_key
  on tile_library (tile_name_key(name));

create index if not exists tile_library_used_idx
  on tile_library (times_used desc, last_used_at desc nulls last);

create table if not exists tile_library_options (
  id         uuid     primary key default gen_random_uuid(),
  library_id uuid     not null references tile_library(id) on delete cascade,
  label      text     not null check (btrim(label) <> ''),
  points     smallint not null default 1 check (points between 1 and 30),
  sort       smallint not null default 0,
  grp        text
);

create index if not exists tile_library_options_idx
  on tile_library_options (library_id, sort);

-- Which entry a square was filled from. Nullable and `set null` on delete: a
-- board must not break because a library entry was tidied away afterwards, and
-- a pasted board has no entry at all. It is a provenance note, never a join the
-- game logic depends on -- the square carries its own copy of every field, so
-- re-pricing a library entry cannot change a board that is already running.
alter table tiles add column if not exists library_id uuid
  references tile_library(id) on delete set null;

-- ============================================================
-- 2. Row level security
-- ============================================================
-- Nothing but an admin ever touches either table, and every route in is a
-- definer function below. Deny direct reads outright rather than writing an
-- is_admin() policy: same answer, and it matches how `tiles` and `tile_options`
-- are already locked down (0001, 20260906135718).

alter table tile_library         enable row level security;
alter table tile_library_options enable row level security;

drop policy if exists tile_library_no_direct_read on tile_library;
create policy tile_library_no_direct_read on tile_library for select using (false);

drop policy if exists tile_library_options_no_direct_read on tile_library_options;
create policy tile_library_options_no_direct_read on tile_library_options for select using (false);

-- ============================================================
-- 3. The rule check, in one place
-- ============================================================
-- `admin_set_tiles` checks these two across the finished board. A square saved
-- on its own has to answer the same questions one tile at a time, and a library
-- entry has to answer them with no board in sight at all -- so the rule moves
-- out of the paste function and all three callers use it.

create or replace function assert_tile_rule_ok(p_completion tile_completion,
                                               p_options int,
                                               p_what text default 'This tile')
returns void
language plpgsql immutable set search_path = public as $$
begin
  if p_completion in ('one_set', 'each_set') and p_options = 0 then
    raise exception '% needs the drops that make up its sets', p_what;
  end if;
  if p_completion = 'value' and p_options > 0 then
    raise exception '% is scored on typed value and cannot also list drops', p_what;
  end if;
end;
$$;

-- ============================================================
-- 4. Reading the catalogue
-- ============================================================

drop function if exists admin_list_library();

create function admin_list_library()
returns table (id uuid, name text, icon text, description text,
               required_evidence smallint, early_complete boolean,
               completion text, per_set smallint, tags text[],
               times_used integer, last_used_at timestamptz, options jsonb)
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  return query
    select l.id, l.name, l.icon, l.description,
           l.required_evidence, l.early_complete,
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
-- 5. Writing one catalogue entry
-- ============================================================
-- `p_id` null inserts, otherwise updates in place. The unique index on the name
-- turns a clash into a 23505, which reads as gibberish in a toast, so it is
-- caught and reworded here.

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
                              early_complete, completion, per_set, tags, created_by)
    values (
      coalesce(p_id, gen_random_uuid()),
      left(v_name, 120),
      nullif(regexp_replace(btrim(coalesce(p_tile ->> 'icon', '')),
                            '[^A-Za-z0-9_-]', '', 'g'), ''),
      nullif(left(btrim(coalesce(p_tile ->> 'description', '')), 500), ''),
      least(greatest(coalesce((nullif(btrim(p_tile ->> 'amount'), ''))::int, 1), 1), 1000),
      coalesce((p_tile ->> 'early')::boolean, false),
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
      early_complete    = excluded.early_complete,
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

create or replace function admin_delete_library_tile(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  delete from tile_library where id = p_id;
end;
$$;

revoke execute on function admin_delete_library_tile(uuid) from public, anon;
grant  execute on function admin_delete_library_tile(uuid) to authenticated;

-- ============================================================
-- 6. Seeding the catalogue from a board that already exists
-- ============================================================
-- The fastest way to a useful library is the boards already in here. Skips
-- anything whose name is already catalogued rather than overwriting it: an
-- entry may have been tidied, tagged or re-priced since it was imported, and
-- silently reverting that to whatever an old game happens to hold would be
-- the opposite of a library.

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
                              early_complete, completion, per_set, created_by)
    select f.lib_name, f.icon, f.description, f.required_evidence,
           f.early_complete, f.completion, f.per_set, auth.uid()
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

-- ============================================================
-- 7. One square at a time
-- ============================================================
-- The payload is the shape `parseTileLine` already emits -- name, icon, amount,
-- early, rule, perSet, description, options[] -- plus an optional `libraryId`
-- saying which catalogue entry it was filled from. Deliberately the same shape
-- as one element of the array `admin_set_tiles` takes, so that the builder and
-- the paste box cannot drift into two different ideas of what a tile is.

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
                     early_complete, description, completion, per_set, library_id)
  values (
    p_game_id, p_row, p_col,
    coalesce(nullif(btrim(p_tile ->> 'name'), ''), 'Tile'),
    nullif(regexp_replace(btrim(coalesce(p_tile ->> 'icon', '')),
                          '[^A-Za-z0-9_-]', '', 'g'), ''),
    least(greatest(coalesce((nullif(btrim(p_tile ->> 'amount'), ''))::int, 1), 1), 1000),
    coalesce((p_tile ->> 'early')::boolean, false),
    nullif(left(btrim(coalesce(p_tile ->> 'description', '')), 500), ''),
    v_completion,
    least(greatest(coalesce((nullif(btrim(p_tile ->> 'perSet'), ''))::smallint, 1), 1), 30),
    v_library
  )
  on conflict (game_id, "row", col) do update set
    name              = excluded.name,
    icon              = excluded.icon,
    required_evidence = excluded.required_evidence,
    early_complete    = excluded.early_complete,
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

create or replace function admin_clear_tile(p_game_id uuid,
                                            p_row smallint,
                                            p_col smallint)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_game games%rowtype;
begin
  if not is_admin() then raise exception 'Admins only'; end if;

  select * into v_game from games where id = p_game_id;
  if not found then raise exception 'No such game'; end if;
  if v_game.status not in ('setup', 'placement') then
    raise exception 'Tiles are locked once the game is %', v_game.status;
  end if;

  -- tile_options and any pet jar preview go with it on cascade. A claim cannot
  -- exist yet: the game has not started.
  delete from tiles where game_id = p_game_id and "row" = p_row and col = p_col;
end;
$$;

revoke execute on function admin_clear_tile(uuid, smallint, smallint) from public, anon;
grant  execute on function admin_clear_tile(uuid, smallint, smallint) to authenticated;

-- ============================================================
-- 8. The paste box, on the shared rule check
-- ============================================================
-- Unchanged behaviour: the same two conditions, now read from
-- `assert_tile_rule_ok` so that the builder and the paste box cannot disagree
-- about what a valid tile is. `library_id` is not set here, and the wholesale
-- delete above clears it, so re-pasting over a built board leaves no stale
-- provenance behind.

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

-- ============================================================
-- 9. The organiser board, now carrying provenance
-- ============================================================
-- One column added, `library_id`, so the builder can mark which squares came
-- from the catalogue and which were typed into this board alone. Dropped and
-- recreated rather than replaced: the return type changes.

drop function if exists admin_list_tiles(uuid);

create function admin_list_tiles(p_game_id uuid)
returns table (id uuid, "row" smallint, col smallint, "position" smallint,
               name text, icon text, required_evidence smallint,
               early_complete boolean, options jsonb, description text,
               completion text, per_set smallint, library_id uuid)
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
           t.description, t.completion::text, t.per_set, t.library_id
      from tiles t where t.game_id = p_game_id order by t.position;
end;
$$;

revoke execute on function admin_list_tiles(uuid) from public, anon;
grant  execute on function admin_list_tiles(uuid) to authenticated;
