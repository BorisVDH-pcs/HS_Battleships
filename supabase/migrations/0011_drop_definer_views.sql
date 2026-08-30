-- HS_Battleships — retire the two security-definer views
--
-- Runs AFTER the bundle calling the 0010 functions is live. Dropping these while
-- an old bundle is still doing `.from('tiles_for_me')` would blank every player's
-- board until they hard-refreshed, so the order matters:
--
--   0010 create functions  ->  deploy frontend  ->  0011 drop views
--
-- A function and a view may share a name in Postgres (pg_proc and pg_class are
-- separate), which is what makes the overlap window possible at all.
--
-- This clears both `security_definer_view` CRITICALs from the Supabase advisor.
-- See docs/architecture.md — the definer property was never the problem, but a
-- permanently-red advisor is, because it hides the next real finding.

drop view if exists tiles_for_me;
drop view if exists team_scores;
