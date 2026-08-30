-- Tile icons, replacing per-tile rules.
--
-- The V4 board has no per-tile rules and never will, so `rules` goes rather
-- than sitting NULL in every row and in every function signature. It is empty
-- in the live database (checked: 0 of 100 rows non-null), so nothing is lost.
--
-- `icon` is a filename slug, not a URL or a path — the frontend builds the URL
-- from it. Storing a path would let a bad paste point the board at an
-- off-site image.
--
-- SECURITY: the icon is secret #2, exactly like the name. A Dragon warhammer
-- icon on an unclaimed tile tells the enemy what is on that square. It is
-- redacted in tiles_for_me() below, and that redaction is also what stops the
-- images leaking over the network: with no icon value the browser has no
-- filename to request, so nothing about unclaimed tiles shows up in the
-- network log either.
--
-- Both functions must be DROPped rather than replaced: `create or replace`
-- cannot change a RETURNS TABLE list. Dropping a function also drops its
-- grants, so those are re-applied at the bottom — miss that and every player
-- loses the board.

alter table tiles add column if not exists icon text;
alter table tiles drop column if exists rules;

-- ---- what a player may see -------------------------------------------------

drop function if exists tiles_for_me(uuid);

create function tiles_for_me(p_game_id uuid)
returns table (
  id uuid, game_id uuid, "row" smallint, col smallint, "position" smallint,
  revealed boolean, name text, icon text,
  claim_id uuid, claim_status claim_status, claim_result shot_result
)
language sql stable security definer set search_path = public as $$
  select t.id, t.game_id, t.row, t.col, t.position,
    (c.id is not null) as revealed,
    case when c.id is not null then t.name end as name,
    case when c.id is not null then t.icon end as icon,
    c.id, c.status, c.result
  from tiles t
  left join tile_claims c on c.tile_id = t.id
       and c.team_id in (select my_team_ids())
  where t.game_id = p_game_id
  order by t.position;
$$;

-- ---- what an admin may see -------------------------------------------------

drop function if exists admin_list_tiles(uuid);

create function admin_list_tiles(p_game_id uuid)
returns table (id uuid, "row" smallint, col smallint, "position" smallint,
               name text, icon text)
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  return query
    select t.id, t.row, t.col, t.position, t.name, t.icon
      from tiles t where t.game_id = p_game_id order by t.position;
end;
$$;

-- ---- writing tiles ---------------------------------------------------------
-- Signature is unchanged, so this one can be replaced in place.

create or replace function admin_set_tiles(p_game_id uuid, p_tiles jsonb)
returns int
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

  insert into tiles (game_id, row, col, name, icon)
  select p_game_id,
         (t ->> 'row')::smallint,
         (t ->> 'col')::smallint,
         coalesce(nullif(btrim(t ->> 'name'), ''), 'Tile'),
         -- A slug only: strip anything that could turn into a path or a URL,
         -- so a stray paste cannot point the board off-site.
         nullif(regexp_replace(btrim(coalesce(t ->> 'icon', '')),
                               '[^A-Za-z0-9_-]', '', 'g'), '')
    from jsonb_array_elements(p_tiles) t;

  return v_count;
end;
$$;

-- ---- grants ----------------------------------------------------------------
-- Dropping a function drops its grants with it, and `grant to authenticated`
-- does not remove PUBLIC's implicit EXECUTE. See 0003 and 0010.

revoke execute on function tiles_for_me(uuid)     from public, anon;
revoke execute on function admin_list_tiles(uuid) from public, anon;

grant execute on function tiles_for_me(uuid)     to authenticated;
grant execute on function admin_list_tiles(uuid) to authenticated;
