-- One team per game, chosen the same way everywhere.
--
-- `my_team_ids()` answers "every team this player has ever been in", across all
-- games. That is the right question for the RLS policies -- a player genuinely
-- does belong to many teams over a season -- but the wrong one for anything
-- answering "my side of THIS game". Where a player sat in both teams of one
-- game, three callers merged the two sides together:
--
--   * tiles_for_me left-joined claims from both teams, so a tile claimed by
--     each side came back TWICE -- 101 rows for a 100-tile board, measured --
--     and the opponent's claims were painted on the player's own grid, with
--     the active-tile slots and their upload controls attached to them. A drop
--     on such a slot submits evidence for the other team, and passes
--     add_evidence's membership check while doing it;
--   * my_evidence returned both sides' uploads;
--   * claim_tile's `select ... into` matched two rows and took whichever came
--     back first. PL/pgSQL does not raise on a multi-row SELECT INTO, so the
--     claim landed on an arbitrary team with no error anywhere.
--
-- None of it can happen with one membership per game, which is why it went
-- unnoticed for so long: it takes a roster mistake to appear. But the failure
-- is silent, and it crosses precisely the line the rest of this schema exists
-- to defend -- an enemy claim is secret #2, and the merged fleet count leaks
-- the shape of secret #1. So the scoping is made explicit here rather than
-- left resting on the roster being correct on the night.
--
-- my_team_in_game() breaks the tie by team name, so it agrees with the
-- frontend, which takes the first team of `teams` ordered by name (useGame.js).
-- Deliberately NOT a hard constraint on team_members: a player in both teams
-- is still allowed, because one browser acting for both sides is a genuinely
-- useful testing trick. This makes that state render honestly instead of
-- silently blending the two.

create or replace function my_team_in_game(p_game_id uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select tm.team_id
    from team_members tm
    join teams te on te.id = tm.team_id
   where tm.profile_id = auth.uid()
     and te.game_id = p_game_id
   order by te.name
   limit 1;
$$;

revoke execute on function my_team_in_game(uuid) from public, anon;
grant  execute on function my_team_in_game(uuid) to authenticated;


-- Identical signature and return table to the CURRENT definition, so
-- `create or replace` keeps the existing grants. The only change is the join
-- predicate on the last line of the body.
--
-- Note that current definition is the one in 0021, not the one in 0014: the
-- evidence work added `required_evidence` and `evidence_count` to the return
-- table. 0014 is the older shape and reads like the live one at a glance, which
-- is a good reason to check pg_get_functiondef() rather than the newest file
-- that happens to mention the function.
create or replace function tiles_for_me(p_game_id uuid)
returns table (
  id uuid, game_id uuid, "row" smallint, col smallint, "position" smallint,
  revealed boolean, name text, icon text,
  required_evidence smallint, evidence_count integer,
  claim_id uuid, claim_status claim_status, claim_result shot_result
)
language sql stable security definer set search_path = public as $$
  select t.id, t.game_id, t.row, t.col, t.position,
    (c.id is not null) as revealed,
    case when c.id is not null then t.name end as name,
    case when c.id is not null then t.icon end as icon,
    case when c.id is not null then t.required_evidence end as required_evidence,
    case when c.id is not null
         then (select count(*) from tile_evidence e where e.claim_id = c.id)
         else 0 end::int as evidence_count,
    c.id, c.status, c.result
  from tiles t
  left join tile_claims c on c.tile_id = t.id
       and c.team_id = my_team_in_game(p_game_id)
  where t.game_id = p_game_id
  order by t.position;
$$;

revoke execute on function tiles_for_me(uuid) from public, anon;
grant  execute on function tiles_for_me(uuid) to authenticated;


create or replace function my_evidence(p_game_id uuid)
returns table (id uuid, claim_id uuid, storage_path text,
               uploaded_by_name text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select e.id, e.claim_id, e.storage_path, e.uploaded_by_name, e.created_at
    from tile_evidence e
    join tile_claims c on c.id = e.claim_id
    join tiles t on t.id = c.tile_id
   where t.game_id = p_game_id
     and e.team_id = my_team_in_game(p_game_id)
   order by e.created_at;
$$;

revoke execute on function my_evidence(uuid) from public, anon;
grant  execute on function my_evidence(uuid) to authenticated;


-- Same guards and the same error messages as before; only the team lookup
-- changes, from an unordered multi-row SELECT INTO to the shared helper.
create or replace function claim_tile(p_tile_id uuid)
returns tile_claims
language plpgsql security definer set search_path = public as $$
declare
  v_team_id uuid;
  v_tile    tiles%rowtype;
  v_claim   tile_claims;
begin
  select * into v_tile from tiles where id = p_tile_id;
  if not found then
    raise exception 'No such tile';
  end if;

  v_team_id := my_team_in_game(v_tile.game_id);

  if v_team_id is null then
    raise exception 'You are not a member of a team in this game';
  end if;

  if (select status from games where id = v_tile.game_id) <> 'active' then
    raise exception 'The game is not active';
  end if;

  insert into tile_claims (team_id, tile_id, claimed_by)
  values (v_team_id, p_tile_id, auth.uid())
  returning * into v_claim;

  -- No tile_name here: the feed is world-readable. See 0001_init.sql.
  insert into game_events (game_id, team_id, type, payload)
  values (v_tile.game_id, v_team_id, 'tile_claimed',
          jsonb_build_object('tile_id', v_tile.id,
                             'position', v_tile.position, 'by', auth.uid()));

  return v_claim;
end;
$$;

revoke execute on function claim_tile(uuid) from public, anon;
grant  execute on function claim_tile(uuid) to authenticated;
