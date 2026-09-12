-- Shuffle the board that is there, rather than dealing a new one
--
-- "Re-randomize the board" has never shuffled anything. It clears every square
-- and calls `admin_autofill_board`, which deals each catalogue entry AT MOST
-- ONCE -- so on a hundred-square board drawn from an eighty-six entry label it
-- hands back eighty-six tiles and fourteen holes, and the board it took away is
-- gone. Worse for the boards worth keeping: the V4 board runs several tasks on
-- purpose more than once, and a one-off tile typed straight onto a square was
-- never in the catalogue at all. Neither can survive a redeal, because neither
-- is something the deal can produce.
--
-- This is the other half of that button. It does not consult the catalogue, add
-- a tile or remove one: it takes the tiles already on the board and moves them
-- between the squares they already occupy. So
--
--   * a square cannot come out empty -- the tiles and the squares are the same
--     set going in and coming out, so it is a permutation, not a draw;
--   * a task placed three times stays placed three times, because duplication
--     is a property of the board here rather than something the deal has to be
--     talked into;
--   * a hand-typed one-off survives, since nothing is ever re-fetched from the
--     catalogue;
--   * `times_used` does not move, because nothing was dealt.
--
-- It is worth being plain about what it does NOT give you: the same hundred
-- tiles every time. Pressing it re-arranges; pressing the redeal beside it
-- re-draws. They are different questions and both get asked.
--
-- HOW THE PERMUTATION AVOIDS TRIPPING OVER ITSELF. `tiles` is unique on
-- (game_id, row, col) and that index is not deferrable, so it is checked
-- row by row: a single UPDATE that swaps two squares fails on whichever row
-- lands first. The fix is the usual one -- park every tile off the board by
-- adding `grid_size` to its row, then deal them back. Both statements write
-- into a range of rows that nothing occupies, so no intermediate state ever
-- collides. `row >= 1` is the only check on the column and parking only ever
-- increases it; `position` is generated from row and col and recomputes itself.
-- The whole thing is one function and therefore one transaction, so a board
-- can never be left sitting in the parked state.
--
-- PARTIALLY DEALT BOARDS. The target squares are exactly the squares that were
-- occupied, so the holes in a half-built board stay where they are and the
-- tiles move among themselves. Spreading them over the empty squares too would
-- make this a second, quieter way to move a tile somewhere nobody asked for.
--
-- WHY SETUP AND PLACEMENT ONLY, when 20260913010000 opened up mid-game edits.
-- That migration lets an unclaimed square be CORRECTED in place; this moves
-- squares past each other. Once a game is active a square's coordinates are the
-- shot: teams have previewed squares (0039), locked squares in, and fired at
-- coordinates that mean something. A shuffle would silently rewrite what every
-- one of those referred to. The claim check below is belt and braces -- a claim
-- before `active` should not exist -- and cheap next to the alternative.

create or replace function admin_shuffle_board(p_game_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_game   games%rowtype;
  v_count  int;
  v_moved  int;
begin
  if not is_admin() then raise exception 'Admins only'; end if;

  select * into v_game from games where id = p_game_id;
  if not found then raise exception 'No such game'; end if;

  if v_game.status not in ('setup', 'placement') then
    raise exception 'The board can only be shuffled before the game starts — it is %',
      v_game.status;
  end if;

  if exists (select 1
               from tile_claims c
               join tiles t on t.id = c.tile_id
              where t.game_id = p_game_id) then
    raise exception 'A team has already locked a square in — the board cannot be shuffled';
  end if;

  select count(*) into v_count from tiles where game_id = p_game_id;
  if v_count < 2 then
    return jsonb_build_object('tiles', v_count, 'moved', 0);
  end if;

  -- Park. Rows 1..grid_size become grid_size+1..2*grid_size, a range no tile
  -- of this game occupies, so nothing collides on the way out.
  update tiles
     set "row" = ("row" + v_game.grid_size)::smallint
   where game_id = p_game_id;

  -- Deal back. `slots` is the set of squares that were occupied, in board
  -- order; `parked` is the same tiles in a random order. Joining them on the
  -- two row numbers is the permutation. Targets are 1..grid_size and sources
  -- are above it, so again nothing collides part-way through.
  with parked as materialized (
    select id,
           ("row" - v_game.grid_size)::smallint as was_row,
           col                                  as was_col,
           row_number() over (order by random()) as pick
      from tiles
     where game_id = p_game_id
  ),
  slots as materialized (
    select ("row" - v_game.grid_size)::smallint as r,
           col                                  as c,
           row_number() over (order by "row", col) as slot
      from tiles
     where game_id = p_game_id
  ),
  dealt as (
    update tiles t
       set "row" = s.r, col = s.c
      from parked p
      join slots s on s.slot = p.pick
     where t.id = p.id
    returning s.r, s.c, p.was_row, p.was_col
  )
  select count(*) filter (where d.r <> d.was_row or d.c <> d.was_col)
    into v_moved
    from dealt d;

  return jsonb_build_object('tiles', v_count, 'moved', v_moved);
end;
$$;

revoke execute on function admin_shuffle_board(uuid) from public, anon;
grant  execute on function admin_shuffle_board(uuid) to authenticated;
