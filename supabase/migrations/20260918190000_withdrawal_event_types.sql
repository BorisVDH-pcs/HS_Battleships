-- Two event types, so a revoke can be told twice: once in full to the team it
-- happened to, once as a bare fact to the other team.
--
-- `evidence_revoked` is team-private and stays that way — it names the tile,
-- the drop and the square. But the enemy can SEE a withdrawn shot: an un-fired
-- claim drops out of `enemyShots`, so the mark vanishes off their own fleet
-- with no explanation. `shot_withdrawn` is that explanation, and carries
-- nothing else: no tile name, no position, no drop.
--
-- `tile_relocked` covers the other half. Locking a parked tile back in used to
-- emit `tile_claimed`, which is global and names the square — so the enemy
-- would see the same coordinate announced twice, which is a tell that
-- something was undone. This one is team-private, so the team's own feed still
-- says who picked it back up and the enemy sees nothing at all.
--
-- Separate migration because a new enum value cannot be used in the same
-- transaction that adds it.

alter type event_type add value if not exists 'shot_withdrawn';
alter type event_type add value if not exists 'tile_relocked';
