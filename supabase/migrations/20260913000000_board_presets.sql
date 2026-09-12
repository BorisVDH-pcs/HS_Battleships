-- A whole board, saved and laid down again.
--
-- The V4 board is a hundred squares placed by hand, eighteen of them deliberate
-- repeats of four tiles. Nothing in this system could reproduce it:
-- `admin_autofill_board` cannot repeat a tile at all, its tagged pool is
-- eighty-six against a hundred squares, and it places at random. So the board
-- existed in exactly one place -- the `tiles` rows of one game -- with
-- `admin_clear_board` one button away and no way back. (The claim in
-- v4-handover.md that the tag alone could rebuild it was written before the
-- repeats existed, and is corrected in this commit.)
--
-- WHY JSONB AND NOT A THIRD SET OF TABLES. The tile shape is already stored
-- twice -- `tiles`/`tile_options` for a board, `tile_library`/
-- `tile_library_options` for the catalogue -- and adding `max_times` meant
-- touching both. A third normalised copy would mean every future tile column
-- lands in three places, and the third would be the one somebody forgets.
--
-- A preset is only ever written whole and read whole; nothing queries inside
-- one. And `admin_set_tile` already takes a tile as jsonb, so a preset is
-- literally the list of payloads for a hundred squares -- a shape that already
-- exists and is already what the builder sends. A preset written before some
-- future column exists simply lacks that key, and the `coalesce` defaults in
-- the insert below absorb it, so old presets age gracefully instead of
-- failing.
--
-- SNAPSHOT, NOT LINKS. `library_id` is carried for provenance, but every field
-- is copied. Board squares have been snapshots since 0051 for a reason: editing
-- a catalogue entry deliberately does not reach back into placed tiles. A
-- preset that changed under you when you edited the catalogue would not be a
-- backup of anything.
--
-- SECURITY. A preset is a hundred tile names and their drop lists: secret #2
-- entire. RLS on, select policy false, every read through a definer function
-- gated on `is_admin()` -- the same treatment `tiles` and `tile_options` get,
-- for the same reason. `admin_list_board_presets` deliberately does NOT return
-- the `squares` column; the list needs a name and a count, not the board.

create table if not exists board_presets (
  id         uuid        primary key default gen_random_uuid(),
  name       text        not null check (btrim(name) <> ''),
  grid_size  smallint    not null,
  squares    jsonb       not null,
  created_by uuid        references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One preset per name, compared the way tile names are compared (0050's
-- `tile_name_key`), so "V4 final" and "v4  final" are the same preset and
-- saving over it updates rather than quietly making a second one.
create unique index if not exists board_presets_name_key
  on board_presets (tile_name_key(name));

alter table board_presets enable row level security;

drop policy if exists board_presets_no_direct_read on board_presets;
create policy board_presets_no_direct_read on board_presets for select using (false);

comment on column board_presets.squares is
  'The whole board: [{row, col, tile: <admin_set_tile payload>}]. Snapshot, not '
  'links -- see the header of this migration.';

-- ============================================================
-- 1. Saving one
-- ============================================================
-- Named rather than timestamped, and an existing name is overwritten on
-- purpose: "save the board as it is now" is something an organiser does
-- repeatedly while building, and a list of forty presets called "V4 final (3)"
-- helps nobody. The overwrite is the caller's to confirm.

create or replace function admin_save_board_preset(p_game_id uuid, p_name text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_game    games%rowtype;
  v_name    text;
  v_squares jsonb;
  v_id      uuid;
  v_count   int;
begin
  if not is_admin() then raise exception 'Admins only'; end if;

  v_name := btrim(coalesce(p_name, ''));
  if v_name = '' then raise exception 'A saved board needs a name'; end if;

  select * into v_game from games where id = p_game_id;
  if not found then raise exception 'No such game'; end if;

  select jsonb_agg(s.j order by s.position), count(*)
    into v_squares, v_count
    from (
      select t.position,
             jsonb_build_object(
               'row', t."row",
               'col', t.col,
               -- strip_nulls so a preset carries only what the tile actually
               -- had; admin_set_tile's own coalesces supply the rest, which is
               -- also what lets an older preset load into a newer schema.
               'tile', jsonb_strip_nulls(jsonb_build_object(
                 'name',        t.name,
                 'icon',        t.icon,
                 'description', t.description,
                 'rule',        t.completion::text,
                 'amount',      t.required_evidence,
                 'perSet',      t.per_set,
                 'libraryId',   t.library_id,
                 'options', (
                   select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                            'label',    o.label,
                            'points',   o.points,
                            'grp',      o.grp,
                            'maxTimes', o.max_times))
                          order by o.sort, o.label)
                     from tile_options o where o.tile_id = t.id
                 )
               ))
             ) as j
        from tiles t where t.game_id = p_game_id
    ) s;

  if coalesce(v_count, 0) = 0 then
    raise exception 'That board has no tiles to save';
  end if;

  insert into board_presets (name, grid_size, squares, created_by)
  values (left(v_name, 80), v_game.grid_size, v_squares, auth.uid())
  on conflict (tile_name_key(name)) do update set
    name       = excluded.name,
    grid_size  = excluded.grid_size,
    squares    = excluded.squares,
    updated_at = now()
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'name', v_name, 'squares', v_count);
end;
$$;

revoke execute on function admin_save_board_preset(uuid, text) from public, anon;
grant  execute on function admin_save_board_preset(uuid, text) to authenticated;

-- ============================================================
-- 2. The list
-- ============================================================
-- Without `squares`. The picker needs to know which board this is and how big,
-- and shipping a hundred tile names to draw a dropdown row would be handing out
-- secret #2 to build a `<select>`.

create or replace function admin_list_board_presets()
returns table (
  id uuid, name text, grid_size smallint, squares integer,
  created_at timestamptz, updated_at timestamptz, created_by_name text
)
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  return query
    select b.id, b.name, b.grid_size,
           jsonb_array_length(b.squares)::int,
           b.created_at, b.updated_at, p.display_name
      from board_presets b
      left join profiles p on p.id = b.created_by
     order by b.updated_at desc;
end;
$$;

revoke execute on function admin_list_board_presets() from public, anon;
grant  execute on function admin_list_board_presets() to authenticated;

-- ============================================================
-- 3. Laying one down
-- ============================================================
-- Replaces the board rather than filling its gaps. "Load this board" means this
-- board, and a load that silently did nothing on a full board would be the
-- worse surprise. The caller confirms; this refuses outright once the game is
-- past placement, the same guard `admin_set_tile` and `admin_clear_board` use,
-- so a board cannot change under a team that is already playing it.
--
-- Grid sizes must match. A ten-by-ten preset on a smaller board would place
-- tiles off the edge, and the check constraint would be a confusing way to
-- find that out.

create or replace function admin_apply_board_preset(p_game_id uuid, p_preset_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_game   games%rowtype;
  v_preset board_presets%rowtype;
  v_placed int;
begin
  if not is_admin() then raise exception 'Admins only'; end if;

  select * into v_game from games where id = p_game_id;
  if not found then raise exception 'No such game'; end if;
  if v_game.status not in ('setup', 'placement') then
    raise exception 'Tiles are locked once the game is %', v_game.status;
  end if;

  select * into v_preset from board_presets where id = p_preset_id;
  if not found then raise exception 'No such saved board'; end if;

  if v_preset.grid_size <> v_game.grid_size then
    raise exception 'That board is %x% and this game is %x%',
      v_preset.grid_size, v_preset.grid_size, v_game.grid_size, v_game.grid_size;
  end if;

  -- Belt beside the braces of the status check: a claim on a tile about to be
  -- deleted is a team's work, and losing it silently is not a thing to risk on
  -- one enum comparison.
  if exists (
       select 1 from tile_claims c join tiles t on t.id = c.tile_id
        where t.game_id = p_game_id
     ) then
    raise exception 'This board already has claimed tiles — release them first';
  end if;

  delete from tiles where game_id = p_game_id;

  insert into tiles (game_id, "row", col, name, icon, required_evidence,
                     description, completion, per_set, library_id)
  select p_game_id,
         (s.val ->> 'row')::smallint,
         (s.val ->> 'col')::smallint,
         coalesce(nullif(btrim(s.val -> 'tile' ->> 'name'), ''), 'Tile'),
         nullif(regexp_replace(btrim(coalesce(s.val -> 'tile' ->> 'icon', '')),
                               '[^A-Za-z0-9_-]', '', 'g'), ''),
         least(greatest(coalesce((nullif(btrim(s.val -> 'tile' ->> 'amount'), ''))::int, 1), 1), 1000),
         nullif(left(btrim(coalesce(s.val -> 'tile' ->> 'description', '')), 500), ''),
         coalesce(nullif(btrim(coalesce(s.val -> 'tile' ->> 'rule', '')), ''),
                  'points')::tile_completion,
         least(greatest(coalesce((nullif(btrim(s.val -> 'tile' ->> 'perSet'), ''))::smallint, 1), 1), 30),
         nullif(btrim(coalesce(s.val -> 'tile' ->> 'libraryId', '')), '')::uuid
    from jsonb_array_elements(v_preset.squares) as s(val);

  get diagnostics v_placed = row_count;

  insert into tile_options (tile_id, label, points, sort, grp, max_times)
  select t.id,
         left(btrim(o.val ->> 'label'), 80),
         least(greatest(coalesce((o.val ->> 'points')::smallint, 1), 1), 30),
         (o.ord - 1)::smallint,
         nullif(left(btrim(coalesce(o.val ->> 'grp', '')), 40), ''),
         case when nullif(btrim(coalesce(o.val ->> 'maxTimes', '')), '') is null then null
              else least(greatest((o.val ->> 'maxTimes')::smallint, 1), 30)::smallint end
    from jsonb_array_elements(v_preset.squares) as s(val)
    join tiles t on t.game_id = p_game_id
                and t."row" = (s.val ->> 'row')::smallint
                and t.col   = (s.val ->> 'col')::smallint
   cross join lateral jsonb_array_elements(
                case when jsonb_typeof(s.val -> 'tile' -> 'options') = 'array'
                     then s.val -> 'tile' -> 'options' else '[]'::jsonb end
              ) with ordinality as o(val, ord)
   where btrim(coalesce(o.val ->> 'label', '')) <> '';

  return jsonb_build_object('placed', v_placed, 'name', v_preset.name);
end;
$$;

revoke execute on function admin_apply_board_preset(uuid, uuid) from public, anon;
grant  execute on function admin_apply_board_preset(uuid, uuid) to authenticated;

-- ============================================================
-- 4. Deleting one
-- ============================================================

create or replace function admin_delete_board_preset(p_preset_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  delete from board_presets where id = p_preset_id;
end;
$$;

revoke execute on function admin_delete_board_preset(uuid) from public, anon;
grant  execute on function admin_delete_board_preset(uuid) to authenticated;

-- ============================================================
-- 5. A tag is a tag whatever its case
-- ============================================================
-- Found while answering "what happens if we autofill from the V4 tag": eighty-
-- five entries carried `Battleships V4` and one carried `battleships v4`, so
-- the autofill pool silently missed it. `admin_save_library_tile` lowercases
-- tags as it writes them, while the entries imported before it did not -- so
-- editing any tagged entry through the form drops it out of its own pool, with
-- nothing to see. Matching case-insensitively makes that harmless.

create or replace function admin_autofill_board(p_game_id uuid, p_tag text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_game   games%rowtype;
  v_tag    text := nullif(btrim(coalesce(p_tag, '')), '');
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
       and (v_tag is null or exists (
             select 1 from unnest(l.tags) as tag
              where lower(btrim(tag)) = lower(v_tag)))
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
