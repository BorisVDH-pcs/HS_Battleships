-- HS_Battleships — roll a game back to placement
--
-- Answers one of the open questions in architecture.md: "should there be an
-- admin override to end or roll back a game mid-flight?" Yes. Until now the
-- only way out of `active` was to delete the game, which took its 100 tiles and
-- its roster with it — an hour of setup thrown away to undo a misfire.
--
-- What survives: the game, both teams, the roster, and the tiles.
-- What goes: every claim and shot, the event feed, manual score adjustments,
-- the winner, and — unless asked otherwise — the fleets.
--
-- ORDER IS LOAD-BEARING. `freeze_fleet_after_placement` refuses any write to
-- `ships` or `ship_cells` while the game is not in `placement`, so the status
-- has to be rolled back BEFORE the ships are deleted. Do it the other way round
-- and the whole function aborts on the freeze trigger.

create or replace function admin_reset_game(
  p_game_id      uuid,
  p_clear_fleets boolean default true
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_status game_status;
begin
  if not is_admin() then raise exception 'Admins only'; end if;

  select status into v_status from games where id = p_game_id;
  if not found then
    raise exception 'No such game';
  end if;
  if v_status = 'setup' then
    raise exception 'Game is still in setup — there is nothing to reset';
  end if;

  -- Must come first. See the note above.
  update games
     set status         = 'placement',
         winner_team_id = null,
         started_at     = null,
         ended_at       = null
   where id = p_game_id;

  delete from tile_claims
   where tile_id in (select id from tiles where game_id = p_game_id);

  delete from score_events
   where team_id in (select id from teams where game_id = p_game_id);

  -- The feed is a live activity log, not an audit trail. Leaving shots in it
  -- that no longer exist would be worse than clearing it.
  delete from game_events where game_id = p_game_id;

  if p_clear_fleets then
    delete from ships
     where team_id in (select id from teams where game_id = p_game_id);
  end if;

  -- Written last, so it survives the delete above and is the only thing in the
  -- feed. Its real job is to make every open player page notice: the app
  -- refetches on any game_event insert, so nobody is left staring at a board
  -- that no longer exists.
  insert into game_events (game_id, type, payload)
  values (p_game_id, 'game_reset',
          jsonb_build_object('by', auth.uid(), 'fleets_cleared', p_clear_fleets));
end;
$$;

revoke execute on function admin_reset_game(uuid, boolean) from public, anon;
grant  execute on function admin_reset_game(uuid, boolean) to authenticated;
