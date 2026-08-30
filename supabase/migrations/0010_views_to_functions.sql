-- HS_Battleships — turn the two definer views into definer functions
--
-- The Supabase security advisor raises `security_definer_view` (lint 0010) at
-- CRITICAL for `tiles_for_me` and `team_scores`. Both were deliberate — 0003
-- reviewed and accepted the first — and neither is a hole: the definer property
-- is the mechanism that gates the secret, not a way around it. Making either
-- `security_invoker` would return nothing and break the app.
--
-- They are converted anyway, for two reasons:
--
--   1. A permanently-red advisor is worse than no advisor. Two known-noise
--      CRITICALs sitting there forever is how a real one gets missed.
--   2. Every other privileged read in this schema is already a `security
--      definer` function — `admin_list_tiles`, `admin_list_ship_cells`. These
--      two were the odd ones out. Lint 0010 only scans views.
--
-- Behaviour and security are unchanged. A definer function still runs as its
-- owner while `auth.uid()` stays the CALLER's, which is what makes
-- `my_team_ids()` resolve per-player inside it, exactly as it did in the views.
--
-- The views are NOT dropped here — the deployed bundle is still reading them.
-- They go in 0011, once the frontend that calls these functions is live.

-- ============================================================
-- tiles_for_me(game_id) — secret #2
-- ============================================================
-- Every tile of the grid comes back, because a player needs all 100 positions
-- to see a board. `name` and `rules` come back ONLY where the caller's own team
-- has a claim on that tile. Same rule as the view it replaces.
--
-- `row` and `position` are reserved words in a RETURNS TABLE column list.

create or replace function tiles_for_me(p_game_id uuid)
returns table (
  id           uuid,
  game_id      uuid,
  "row"        smallint,
  col          smallint,
  "position"   smallint,
  revealed     boolean,
  name         text,
  rules        text,
  claim_id     uuid,
  claim_status claim_status,
  claim_result shot_result
)
language sql stable security definer set search_path = public as $$
  select
    t.id,
    t.game_id,
    t.row,
    t.col,
    t.position,
    (c.id is not null)                          as revealed,
    case when c.id is not null then t.name  end as name,
    case when c.id is not null then t.rules end as rules,
    c.id                                        as claim_id,
    c.status                                    as claim_status,
    c.result                                    as claim_result
  from tiles t
  left join tile_claims c
         on c.tile_id = t.id
        and c.team_id in (select my_team_ids())
  where t.game_id = p_game_id
  order by t.position;
$$;

-- ============================================================
-- team_scores(game_id) — the scoreboard
-- ============================================================
-- Counts and totals only, for both teams. Never `score_events.reason`, which is
-- free text and stays behind RLS. See 0009.

create or replace function team_scores(p_game_id uuid)
returns table (
  game_id      uuid,
  team_id      uuid,
  team_name    text,
  tiles_fired  integer,
  hits         integer,
  misses       integer,
  active_tiles integer,
  ships_sunk   integer,
  adjustments  integer,
  total        integer
)
language sql stable security definer set search_path = public as $$
  with base as (
    select
      t.game_id as g_id,
      t.id      as t_id,
      t.name    as t_name,
      (select count(*) from tile_claims c
        where c.team_id = t.id and c.status = 'fired')::int as n_fired,
      (select count(*) from tile_claims c
        where c.team_id = t.id and c.status = 'fired' and c.result = 'hit')::int as n_hits,
      (select count(*) from tile_claims c
        where c.team_id = t.id and c.status = 'fired' and c.result = 'miss')::int as n_misses,
      (select count(*) from tile_claims c
        where c.team_id = t.id and c.status = 'active')::int as n_active,
      (select count(*) from ships s
         join teams et on et.id = s.team_id
        where et.game_id = t.game_id
          and et.id <> t.id
          and not exists (
            select 1 from ship_cells sc
             where sc.ship_id = s.id
               and not exists (
                 select 1 from tiles ti
                   join tile_claims c on c.tile_id = ti.id
                  where ti.game_id = t.game_id
                    and ti.row = sc.row and ti.col = sc.col
                    and c.team_id = t.id
                    and c.status = 'fired' and c.result = 'hit'
               )
          ))::int as n_sunk,
      (select coalesce(sum(se.delta), 0) from score_events se
        where se.team_id = t.id)::int as n_adj
    from teams t
    where t.game_id = p_game_id
  )
  select
    b.g_id, b.t_id, b.t_name,
    b.n_fired, b.n_hits, b.n_misses, b.n_active, b.n_sunk, b.n_adj,
    (b.n_fired * g.points_per_tile
     + b.n_hits * g.points_per_hit
     + b.n_sunk * g.points_per_sink
     + b.n_adj)::int
  from base b
  join games g on g.id = b.g_id
  order by b.t_name;
$$;

-- ============================================================
-- Grants — `grant to authenticated` does not remove PUBLIC's implicit
-- EXECUTE, so each one has to be revoked first. See 0003.
-- ============================================================

revoke execute on function tiles_for_me(uuid) from public, anon;
revoke execute on function team_scores(uuid)  from public, anon;

grant execute on function tiles_for_me(uuid) to authenticated;
grant execute on function team_scores(uuid)  to authenticated;
