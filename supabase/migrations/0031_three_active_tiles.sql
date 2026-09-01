-- Three tiles in hand at once, not two.
--
-- A gameplay change, asked for after watching a full simulated match: with two
-- slots a team is blocked more often than it is playing, because a tile wanting
-- five screenshots holds a slot for a long time and the second one is usually
-- mid-grind too. Three gives a team something to do while the slow tiles fill.
--
-- Nothing in the code needed changing, which is the point of it having been a
-- column all along. The limit is read from `games.max_active_tiles` in two
-- places and hardcoded in neither:
--
--   * enforce_active_tile_limit() (0001) — the trigger that actually refuses a
--     third, now a fourth, lock-in.
--   * App.jsx -> ActiveTiles.jsx — the "Active tiles (n/3)" heading and the
--     empty slots under it.
--
-- So this migration only moves the number: the default for new games, the
-- default argument of admin_create_game(), and the games already created that
-- have never been played. An organiser can still pass p_max_active to override
-- it per game.
--
-- Games that are running are deliberately left alone — changing the rules of a
-- match in progress is not something a migration should do quietly. The scratch
-- demo game is updated by hand alongside this.

alter table games alter column max_active_tiles set default 3;

-- Same body as 0006, with the parameter default moved from 2 to 3. Recreated in
-- full rather than patched, because a default is part of the signature and
-- create-or-replace cannot change one in isolation.
create or replace function admin_create_game(
  p_name text, p_team_a text, p_team_b text,
  p_grid_size smallint default 10, p_max_active smallint default 3
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_game_id uuid;
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if btrim(coalesce(p_name,''))   = '' then raise exception 'Game needs a name'; end if;
  if btrim(coalesce(p_team_a,'')) = '' or btrim(coalesce(p_team_b,'')) = '' then
    raise exception 'Both teams need a name';
  end if;
  if btrim(p_team_a) = btrim(p_team_b) then
    raise exception 'The two teams need different names';
  end if;

  insert into games (name, status, grid_size, max_active_tiles)
  values (btrim(p_name), 'setup', p_grid_size, p_max_active)
  returning id into v_game_id;

  insert into teams (game_id, name) values (v_game_id, btrim(p_team_a)), (v_game_id, btrim(p_team_b));

  return v_game_id;
end;
$$;

-- Games not yet under way. `active` and `finished` are left as they were played.
update games set max_active_tiles = 3
 where status in ('setup', 'placement') and max_active_tiles = 2;
