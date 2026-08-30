-- HS_Battleships — a feed event for a reset game
--
-- Split from 0013 for the same reason 0008 was split from 0009: Postgres lets
-- `alter type ... add value` run inside a transaction, but the new value cannot
-- be USED until that transaction commits.

alter type event_type add value if not exists 'game_reset';
