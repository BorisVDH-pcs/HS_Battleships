-- ============================================================
-- The paste box catalogues on its own now
-- ============================================================
-- "Add this board to the catalogue" was a second step for one route onto a
-- board: the paste box (`admin_set_tiles`) wrote straight to `tiles` and left
-- `tile_library` alone, so a pasted hundred had to be walked back into the
-- catalogue by a separate press -- and skipping it meant those tiles could
-- never be dealt by autofill or found by the picker. The square-by-square
-- builder never had this problem: `saveSquare` in BoardBuilder.jsx already
-- files a typed tile in the catalogue in the same press that puts it on the
-- square.
--
-- `admin_set_tiles` now does the same thing. Every name in the paste that the
-- catalogue does not already recognise is filed there, and every square --
-- new or already catalogued -- is linked to its entry via `library_id`.
-- Nothing already catalogued is overwritten, same guarantee
-- `admin_import_board_to_library` always made.
--
-- With that gap closed, the manual step has nothing left to do for a board
-- pasted from here on, so it goes. What it leaves behind is the one-time
-- backfill below, for tiles pasted before this migration existed.

-- ============================================================
-- 1. One-time backfill: catalogue and link everything already on a board
-- ============================================================
-- Same shape as `admin_import_board_to_library`, but over every game at once
-- rather than one at a time, and finished by linking `library_id` back onto
-- the tiles themselves -- which the button never did, and which is what makes
-- "Typed onto this board only" true again only for tiles that actually still
-- deserve it.

with fresh as (
  select distinct on (tile_name_key(t.name)) t.*,
         left(btrim(t.name), 120) as lib_name
    from tiles t
   where btrim(t.name) <> ''
     and not exists (
       select 1 from tile_library l
        where tile_name_key(l.name) = tile_name_key(t.name)
     )
   order by tile_name_key(t.name), t.game_id, t.position
), inserted as (
  insert into tile_library (name, icon, description, required_evidence,
                            completion, per_set, created_by)
  select f.lib_name, f.icon, f.description, f.required_evidence,
         f.completion, f.per_set, null
    from fresh f
  returning id, name
), opts as (
  insert into tile_library_options (library_id, label, points, sort, grp)
  select i.id, o.label, o.points, o.sort, o.grp
    from inserted i
    join fresh f on tile_name_key(f.lib_name) = tile_name_key(i.name)
    join tile_options o on o.tile_id = f.id
  returning 1
)
select 1;

update tiles t
   set library_id = l.id
  from tile_library l
 where t.library_id is null
   and tile_name_key(l.name) = tile_name_key(t.name);

-- ============================================================
-- 2. The paste box, filing as it goes
-- ============================================================

create or replace function admin_set_tiles(p_game_id uuid, p_tiles jsonb)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_game       games%rowtype;
  v_count      int;
  v_catalogued int;
  v_bad        record;
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

  -- Every name this paste holds that the catalogue does not already
  -- recognise is filed there first, on the same terms `saveSquare` in the
  -- builder uses: an entry already catalogued under this name is left
  -- exactly as it is, and the paste's own duplicate names collapse to one
  -- entry (`distinct on`) -- same as `admin_import_board_to_library` always
  -- did.
  with incoming as (
    select distinct on (tile_name_key(t ->> 'name'))
           left(btrim(t ->> 'name'), 120) as lib_name,
           nullif(regexp_replace(btrim(coalesce(t ->> 'icon', '')),
                                 '[^A-Za-z0-9_-]', '', 'g'), '') as icon,
           nullif(left(btrim(coalesce(t ->> 'description', '')), 500), '') as description,
           least(greatest(coalesce((nullif(btrim(t ->> 'amount'), ''))::int, 1), 1), 1000)
             as required_evidence,
           coalesce(nullif(btrim(coalesce(t ->> 'rule', '')), ''), 'points')::tile_completion
             as completion,
           least(greatest(coalesce((nullif(btrim(t ->> 'perSet'), ''))::smallint, 1), 1), 30)
             as per_set,
           t as raw
      from jsonb_array_elements(p_tiles) t
     where btrim(coalesce(t ->> 'name', '')) <> ''
     order by tile_name_key(t ->> 'name'), (t ->> 'row')::int, (t ->> 'col')::int
  ),
  new_entries as (
    insert into tile_library (name, icon, description, required_evidence,
                              completion, per_set, created_by)
    select i.lib_name, i.icon, i.description, i.required_evidence,
           i.completion, i.per_set, auth.uid()
      from incoming i
     where not exists (
             select 1 from tile_library l
              where tile_name_key(l.name) = tile_name_key(i.lib_name)
           )
    returning id, name
  ),
  -- Never selected from below, same as `admin_import_board_to_library`'s
  -- `opts` -- a data-modifying CTE runs whether or not anything reads it.
  new_opts as (
    insert into tile_library_options (library_id, label, points, sort, grp)
    select ne.id,
           left(btrim(o.val ->> 'label'), 80),
           least(greatest(coalesce((o.val ->> 'points')::smallint, 1), 1), 30),
           (o.ord - 1)::smallint,
           nullif(left(btrim(coalesce(o.val ->> 'grp', '')), 40), '')
      from new_entries ne
      join incoming i on tile_name_key(i.lib_name) = tile_name_key(ne.name)
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(i.raw -> 'options') = 'array'
             then i.raw -> 'options' else '[]'::jsonb end
      ) with ordinality as o(val, ord)
     where btrim(coalesce(o.val ->> 'label', '')) <> ''
    returning 1
  )
  select count(*) into v_catalogued from new_entries;

  -- The insert itself, unchanged except for the last column: every square is
  -- now linked to the entry its name matches, whether that entry already
  -- existed or was just created above.
  insert into tiles (game_id, row, col, name, icon, required_evidence,
                     description, completion, per_set, library_id)
  select p_game_id,
         (t ->> 'row')::smallint,
         (t ->> 'col')::smallint,
         coalesce(nullif(btrim(t ->> 'name'), ''), 'Tile'),
         nullif(regexp_replace(btrim(coalesce(t ->> 'icon', '')),
                               '[^A-Za-z0-9_-]', '', 'g'), ''),
         least(greatest(coalesce((nullif(btrim(t ->> 'amount'), ''))::int, 1), 1), 1000),
         nullif(left(btrim(coalesce(t ->> 'description', '')), 500), ''),
         coalesce(nullif(btrim(coalesce(t ->> 'rule', '')), ''), 'points')::tile_completion,
         least(greatest(coalesce((nullif(btrim(t ->> 'perSet'), ''))::smallint, 1), 1), 30),
         l.id
    from jsonb_array_elements(p_tiles) t
    left join tile_library l
      on btrim(coalesce(t ->> 'name', '')) <> ''
     and tile_name_key(l.name) = tile_name_key(t ->> 'name');

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
-- 3. The manual step, gone
-- ============================================================

drop function if exists admin_import_board_to_library(uuid);
