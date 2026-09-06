-- Emptying a whole board in one press.
--
-- `admin_clear_tile` takes one square, which is right for fixing a mistake and
-- wrong for starting over: a hundred squares is a hundred round trips and a
-- hundred chances to stop halfway, and "start over" is a normal thing to want
-- once autofill exists -- deal a board, read it, dislike it, deal another.
--
-- Same guard as the single-square version, for the same reason: tiles are the
-- board a running game is played on, so this is a setup/placement action only.
-- Returns the number of squares it removed, because the confirmation upstream
-- promised a count and the caller should report what actually went.
--
-- `times_used` on the catalogue is deliberately left alone, exactly as
-- `admin_clear_tile` leaves it. It is a "how often has this task been used on a
-- board" tally that sorts the picker, not a live reference count -- past boards
-- keep their own copies -- and decrementing it here would make an organiser who
-- re-deals a board twice sink their most useful tiles to the bottom of the list.

create or replace function admin_clear_board(p_game_id uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_game    games%rowtype;
  v_removed integer;
begin
  if not is_admin() then raise exception 'Admins only'; end if;

  select * into v_game from games where id = p_game_id;
  if not found then raise exception 'No such game'; end if;
  if v_game.status not in ('setup', 'placement') then
    raise exception 'Tiles are locked once the game is %', v_game.status;
  end if;

  -- tile_options and any pet jar preview go with them on cascade. No claim can
  -- exist yet: the game has not started.
  delete from tiles where game_id = p_game_id;
  get diagnostics v_removed = row_count;
  return v_removed;
end;
$$;

revoke execute on function admin_clear_board(uuid) from public, anon;
grant  execute on function admin_clear_board(uuid) to authenticated;
