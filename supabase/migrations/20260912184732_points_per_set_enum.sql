-- ============================================================
-- A fourth completion rule: points, but counted per set
-- ============================================================
-- Alone in its own migration because `alter type ... add value` cannot be used
-- in the same transaction that adds it. Everything built on the new value is
-- in the migration that follows; this file exists only so that one can name it.

alter type tile_completion add value if not exists 'points_per_set';
