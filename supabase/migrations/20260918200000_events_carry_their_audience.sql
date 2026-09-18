-- Each event says who can read it, so the client stops keeping its own copy.
--
-- `EventFeed.jsx` tags every line [GLOBAL] or [TEAM] from a hand-written Set
-- that mirrors `is_team_private_event()`. Nothing kept the two in step, and
-- they drifted the first time it mattered: `evidence_revoked` was added to the
-- function and missed in the Set, so revokes were labelled [GLOBAL] on a screen
-- where the RLS policy was correctly hiding them from the other team.
--
-- Nothing leaked — the label was wrong, not the gating — but a label that calls
-- a private thing public is worth about as much as a leak, because it is acted
-- on the same way. An organiser reading [GLOBAL] next to a revoke has no reason
-- to believe the tile name is still secret, and will plan around a rule that
-- isn't the real one.
--
-- The fix is to stop having two answers. `board_for_me` is the only way an
-- event reaches the client — Realtime is just the signal to refetch, it never
-- appends a payload — so one field added here reaches every reader, and the
-- Set can go.
--
-- Deliberately computed rather than stored: it is a property of the event TYPE,
-- not of the row, and `is_team_private_event` is immutable. A column would be a
-- third copy that could drift from the function the way the Set did.
--
-- Body otherwise verbatim from 20260913121146.

create or replace function board_for_me(p_game_id uuid)
returns jsonb
language plpgsql stable set search_path = public as $$
declare
  v_uid        uuid := auth.uid();
  v_my_team    uuid;
  v_enemy_team uuid;
begin
  select t.id into v_my_team
  from teams t
  where t.game_id = p_game_id
    and exists (
      select 1 from team_members tm
      where tm.team_id = t.id and tm.profile_id = v_uid
    )
  order by t.name
  limit 1;

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
      -- The one new thing: every row carries the same answer the RLS policy
      -- used to let it through, so the feed can label it without guessing.
      -- Note this is not a permission check — RLS has already decided what is
      -- in this set. It says which audience the row was written for.
      select jsonb_agg(
               to_jsonb(e) || jsonb_build_object(
                 'team_private', is_team_private_event(e.type))
               order by e.created_at desc)
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

-- No grant changes on purpose. `create or replace` keeps the existing ACL, and
-- this function is currently executable by `anon` and PUBLIC as well as
-- `authenticated`. Tightening that may well be right — it is an invoker
-- function, so RLS already decides what anon can actually see — but it is a
-- separate decision with its own blast radius, and burying it in a migration
-- about event labels is how an unrelated sign-in path breaks.
