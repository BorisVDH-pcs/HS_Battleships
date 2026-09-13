-- One round trip for the whole board.
--
-- useGame's `load` made ten requests: three to work out which team the player
-- is on, five for the board itself, then evidence and the enemy's shots. Every
-- one of them is an HTTP request through PostgREST, and every open board makes
-- the whole set again each time a game_event lands. At fifty players that is
-- five hundred requests per event where fifty will do.
--
-- SECURITY INVOKER deliberately, not DEFINER. Every table read below still
-- passes through the same RLS policies the client's own queries did, so this
-- function cannot widen what a player can see even if a filter here is wrong --
-- the policies remain the backstop. The three reads that are allowed to reveal
-- more than RLS alone (tiles_for_me, team_scores, my_evidence) are called as
-- the `security definer` functions they already were, rather than reimplemented
-- here where the secrecy rules would have to be kept in step by hand.
--
-- The row shapes match what the client already destructured, so the board keeps
-- reading the same fields.
create or replace function public.board_for_me(p_game_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_uid        uuid := auth.uid();
  v_my_team    uuid;
  v_enemy_team uuid;
begin
  -- Mirrors the client exactly: teams ordered by name, first one this player
  -- belongs to. A player somehow in both teams of one game resolves the same
  -- way it did before rather than a new way.
  select t.id into v_my_team
  from teams t
  where t.game_id = p_game_id
    and exists (
      select 1 from team_members tm
      where tm.team_id = t.id and tm.profile_id = v_uid
    )
  order by t.name
  limit 1;

  -- And the same for the enemy: the first team by name that is not mine. With
  -- no team of my own -- an admin, a spectator -- that is simply the first,
  -- which is what `teams.find(t => t.id !== myTeamId)` returned.
  select t.id into v_enemy_team
  from teams t
  where t.game_id = p_game_id
    and (v_my_team is null or t.id <> v_my_team)
  order by t.name
  limit 1;

  return jsonb_build_object(
    'game', (select to_jsonb(g) from games g where g.id = p_game_id),

    'teams', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.name)
      from teams t where t.game_id = p_game_id
    ), '[]'::jsonb),

    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object('team_id', tm.team_id, 'role', tm.role))
      from team_members tm where tm.profile_id = v_uid
    ), '[]'::jsonb),

    'tiles', coalesce((
      select jsonb_agg(to_jsonb(x)) from tiles_for_me(p_game_id) x
    ), '[]'::jsonb),

    -- Team-filtered for the reason the client spelled out: RLS allows my teams
    -- across every game I have ever played, so without this a second game's
    -- ships would be drawn onto this board and miscount the fleet.
    'myShipCells', coalesce((
      select jsonb_agg(to_jsonb(sc)) from ship_cells sc
      where (v_my_team is null or sc.team_id = v_my_team)
    ), '[]'::jsonb),

    'myFleet', coalesce((
      select jsonb_agg(to_jsonb(ss)) from ship_status ss
      where ss.game_id = p_game_id
        and (v_my_team is null or ss.team_id = v_my_team)
    ), '[]'::jsonb),

    'events', coalesce((
      select jsonb_agg(to_jsonb(e) order by e.created_at desc)
      from (
        select * from game_events
        where game_id = p_game_id
        order by created_at desc
        limit 50
      ) e
    ), '[]'::jsonb),

    'scores', coalesce((
      select jsonb_agg(to_jsonb(s)) from team_scores(p_game_id) s
    ), '[]'::jsonb),

    'evidence', coalesce((
      select jsonb_agg(to_jsonb(ev)) from my_evidence(p_game_id) ev
    ), '[]'::jsonb),

    -- The enemy's fired claims, which land as shots on my own board.
    'enemyShots', coalesce((
      select jsonb_agg(jsonb_build_object(
        'tile_id', tc.tile_id, 'result', tc.result, 'status', tc.status))
      from tile_claims tc
      where v_enemy_team is not null
        and tc.team_id = v_enemy_team
        and tc.status = 'fired'
    ), '[]'::jsonb)
  );
end;
$$;

grant execute on function public.board_for_me(uuid) to authenticated;
