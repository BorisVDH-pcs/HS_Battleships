-- The sentence that says what a tile actually counts.
--
-- (No tile text in this file: this repo is public and the tile contents are
-- secret #2. Shapes described in the abstract, as in 0025 and 0046.)
--
-- The V4 tile sheet carries a second column next to most tiles -- a line of
-- prose explaining what counts toward it: which drops from a boss are on the
-- list, whether duplicates are allowed, what a "set" means here, where to take
-- the before-and-after screenshot. Until now that column had nowhere to go, so
-- it lived in the organiser's spreadsheet and reached players over Discord, one
-- question at a time, during the event.
--
-- So `tiles` grows a `description`. It is not a second name and it is not
-- rules-as-data: nothing in the database reads it, no trigger branches on it,
-- and a tile without one behaves exactly as it does today. It exists to be
-- shown next to the tile a team is working on.
--
-- SECURITY: a description is tile content, and a more revealing kind than the
-- name. "Any 2 purple loots at ToA" names the raid; a name like "Two purples"
-- might not. So it is gated on the CLAIM -- the same line 0046 draws for
-- `required_evidence` and `options`, and deliberately NOT the line drawn for
-- name and icon.
--
-- That difference matters, because those two lines are not the same. A pet jar
-- preview (0039) reveals what a tile IS: its name and its picture, so a team
-- can decide whether to spend a jar on that square. It has never revealed what
-- the tile COSTS. A description is cost -- it is the small print of the target
-- -- so it follows required_evidence, not name. A previewed-but-unclaimed tile
-- shows its name and artwork and nothing else, exactly as before.
--
-- Both functions below change their RETURNS TABLE list, so both must be
-- DROPped and rebuilt rather than replaced -- and dropping a function drops its
-- grants with it. They are re-applied at the bottom of each section; miss that
-- and every player loses the board (0014 learned this the hard way).

alter table tiles add column if not exists description text;

comment on column tiles.description is
  'Free prose explaining what counts toward this tile. Shown only to a team '
  'that has claimed it -- see 0048. Never read by the database itself.';

-- ============================================================
-- 1. The board a team can see
-- ============================================================

drop function if exists tiles_for_me(uuid);

create function tiles_for_me(p_game_id uuid)
returns table (
  id uuid, game_id uuid, "row" smallint, col smallint, "position" smallint,
  revealed boolean, name text, icon text,
  required_evidence smallint, evidence_count integer, early_complete boolean,
  claim_id uuid, claim_status claim_status, claim_result shot_result,
  previewed boolean, ship_sunk boolean,
  evidence_points integer, options jsonb, description text
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
         end as options,
    -- Claim-gated, for the reason at the top of this file: this is cost, not
    -- identity, so a pet jar preview does not carry it.
    case when c.id is not null then t.description end as description
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
-- 2. The organiser's own board
-- ============================================================
-- An organiser proofreading a hundred pasted lines needs to see the
-- description come back, for the same reason 0046 added the prices here: a
-- field you can paste but never read back is a field you cannot check.

drop function if exists admin_list_tiles(uuid);

create function admin_list_tiles(p_game_id uuid)
returns table (id uuid, "row" smallint, col smallint, "position" smallint,
               name text, icon text, required_evidence smallint,
               early_complete boolean, options jsonb, description text)
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  return query
    select t.id, t.row, t.col, t.position, t.name, t.icon,
           t.required_evidence, t.early_complete,
           (select coalesce(jsonb_agg(jsonb_build_object(
                     'id', o.id, 'label', o.label, 'points', o.points
                   ) order by o.sort, o.label), '[]'::jsonb)
              from tile_options o where o.tile_id = t.id),
           t.description
      from tiles t where t.game_id = p_game_id order by t.position;
end;
$$;

revoke execute on function admin_list_tiles(uuid) from public, anon;
grant  execute on function admin_list_tiles(uuid) to authenticated;

-- ============================================================
-- 3. Saving the description with the tile
-- ============================================================
-- Trimmed and capped rather than rejected. This arrives as one line of a
-- hundred-line paste, and a description that is too long is a formatting slip,
-- not a reason to refuse the other ninety-nine. 500 characters is roughly four
-- times the longest line in the V4 sheet, so the cap should never be reached in
-- practice -- it is there to stop a whole pasted document ending up in one row.
--
-- No cast and no branch on the value: unlike `amount` and `points`, this field
-- has no wrong values, only long ones.

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
                     early_complete, description)
  select p_game_id,
         (t ->> 'row')::smallint,
         (t ->> 'col')::smallint,
         coalesce(nullif(btrim(t ->> 'name'), ''), 'Tile'),
         nullif(regexp_replace(btrim(coalesce(t ->> 'icon', '')),
                               '[^A-Za-z0-9_-]', '', 'g'), ''),
         least(greatest(coalesce((nullif(btrim(t ->> 'amount'), ''))::smallint, 1), 1), 30),
         coalesce((t ->> 'early')::boolean, false),
         nullif(left(btrim(coalesce(t ->> 'description', '')), 500), '')
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
