-- A reset that leaves the pet jar state behind is not a reset.
--
-- `admin_reset_game` dates from 0013 and pet jars arrived in 0039, so the
-- function was never taught about them. The visible half of that is what an
-- organiser reported: after a reset, tiles a team had uncovered with a preview
-- stayed uncovered. Rolling the board back to placement while leaving the other
-- side knowing what sits on I7 is not a rollback -- it is a head start.
--
-- There are three pieces of pet jar state, and all three have to go, for the
-- same reason the claims and the feed already do:
--
--   * `pet_jar_previews` -- the uncovered tiles. The reported bug.
--   * `pet_jar_submissions` -- the screenshots that earned the jars. Earned
--     during a run that no longer happened, exactly like tile evidence, which
--     already goes (it cascades off tile_claims).
--   * `teams.pet_jar_count` -- the spendable currency. The one that matters
--     most and shows least: leave it and a team walks into the fresh board
--     holding jars it earned in the old one, ready to uncover several tiles
--     before a shot is fired. That leaves them strictly better off after a
--     reset than before it, which cannot be right.
--
-- Not tied to `p_clear_fleets`. Fleets are a separate axis -- an organiser may
-- legitimately want to keep placements and only undo the shooting. Pet jar
-- state is earned progress, so it clears with the claims and the score events,
-- unconditionally.
--
-- The screenshots themselves stay in the storage bucket. That is unchanged and
-- deliberate: 0021 already notes that orphaned objects are unreachable (nothing
-- points at them once the rows are gone) and that an organiser sweeps the
-- bucket after the event.
--
-- ORDER IS STILL LOAD-BEARING, for the reason 0013 gives:
-- `freeze_fleet_after_placement` refuses any write to `ships` or `ship_cells`
-- while the game is not in `placement`, so the status rollback stays first.
-- The pet jar deletes have no such trigger and sit with the other deletes.

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

  -- The uncovered tiles. Scoped by game_id, which pet_jar_previews carries
  -- directly, so a team playing in two games keeps the other one intact.
  delete from pet_jar_previews where game_id = p_game_id;

  -- The submissions that earned the jars, and the jars themselves.
  delete from pet_jar_submissions where game_id = p_game_id;

  update teams set pet_jar_count = 0 where game_id = p_game_id;

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
