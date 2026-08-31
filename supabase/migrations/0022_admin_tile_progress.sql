-- The organiser's view of both task boards at once.
--
-- AdminBoards already shows the two FLEET boards — where the ships are and what
-- has been shot at them. This is the other half: the shared 100-tile task grid
-- as each team has worked it, including tiles a team has claimed and part-done.
--
-- "Partially completed" only exists now that a tile can need more than one
-- screenshot: a claim sitting at 1 of 3 is a team mid-task, which is exactly the
-- state an organiser wants to see during an event and which nothing else
-- surfaces.
--
-- Every row here pairs a tile's NAME with a TEAM, which is the one combination
-- that must never reach a player — hence is_admin(), the same gate as
-- admin_list_evidence.

create or replace function admin_tile_progress(p_game_id uuid)
returns table (team_id uuid, team_name text, tile_id uuid, "position" smallint,
               tile_name text, required_evidence smallint,
               claim_id uuid, status claim_status, result shot_result,
               evidence_count int)
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  return query
    -- cross join: every team against every tile, so unclaimed squares are rows
    -- too and the client can draw a full 10x10 without filling gaps itself.
    select tm.id, tm.name, t.id, t.position, t.name, t.required_evidence,
           c.id, c.status, c.result,
           (select count(*)::int from tile_evidence e where e.claim_id = c.id)
      from teams tm
      cross join tiles t
      left join tile_claims c on c.tile_id = t.id and c.team_id = tm.id
     where tm.game_id = p_game_id
       and t.game_id = p_game_id
     order by tm.name, t.position;
end;
$$;

revoke execute on function admin_tile_progress(uuid) from public, anon;
grant  execute on function admin_tile_progress(uuid) to authenticated;
