-- HS_Battleships — a feed event for manual score adjustments
--
-- Split out from 0009 on purpose. Postgres lets `alter type ... add value` run
-- inside a transaction, but the new value cannot be USED until that transaction
-- commits — so the RPC that writes it has to land in a later migration.

alter type event_type add value if not exists 'score_adjusted';
