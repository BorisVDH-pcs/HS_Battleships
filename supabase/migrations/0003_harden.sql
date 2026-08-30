-- HS_Battleships — security hardening
--
-- Fixes raised by the Supabase database linter after 0001/0002.

-- ============================================================
-- 1. Keep anonymous visitors out of the game API
-- ============================================================
-- `grant execute ... to authenticated` does NOT remove the implicit EXECUTE that
-- every function grants to PUBLIC, so these were reachable unauthenticated at
-- /rest/v1/rpc/*. Each one is `security definer`, so that has to go.

revoke execute on function place_fleet(uuid, jsonb) from public, anon;
revoke execute on function start_game(uuid)         from public, anon;
revoke execute on function claim_tile(uuid)         from public, anon;
revoke execute on function fire_tile(uuid)          from public, anon;
revoke execute on function my_team_ids()            from public, anon;

grant execute on function place_fleet(uuid, jsonb) to authenticated;
grant execute on function start_game(uuid)         to authenticated;
grant execute on function claim_tile(uuid)         to authenticated;
grant execute on function fire_tile(uuid)          to authenticated;
grant execute on function my_team_ids()            to authenticated;

-- ============================================================
-- 2. ship_status must respect RLS
-- ============================================================
-- As a security-definer view it exposed every ship's damage to everyone, which
-- would let a team watch its shots landing on the enemy fleet in real time.
-- As security_invoker it inherits the RLS on ships/ship_cells, so a team sees
-- only its OWN fleet. The opponent learns about sinkings through `game_events`,
-- which is the deliberate public channel (as the spreadsheet's Discord feed was).
--
-- fire_tile() still reads it for the enemy's ship: inside a security definer
-- function current_user is the function owner, so RLS is bypassed there.

alter view ship_status set (security_invoker = true);

grant select on ship_status to authenticated;

-- ============================================================
-- 3. Pin search_path on the trigger functions
-- ============================================================
-- Without this the functions resolve unqualified names against the caller's
-- search_path, which a caller can set.

alter function enforce_two_teams()            set search_path = public;
alter function freeze_fleet_after_placement() set search_path = public;
alter function enforce_active_limit()         set search_path = public;

-- ============================================================
-- Note on `tiles_for_me`
-- ============================================================
-- The linter also flags `tiles_for_me` as a security-definer view. That one is
-- deliberate and load-bearing: the view exists precisely to bypass the
-- `tiles_no_direct_read` policy and hand back a tile's name only when the
-- caller's own team has claimed it. Making it security_invoker would return
-- nothing at all. Reviewed and accepted.
