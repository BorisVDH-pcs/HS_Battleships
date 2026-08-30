-- Adds the `fleet_placed` event type.
--
-- Split out from 0016 for the same reason as 0008 and 0012: Postgres lets
-- `alter type ... add value` run inside a transaction, but the new value cannot
-- be *used* until that transaction has committed. One file, one commit.

alter type event_type add value if not exists 'fleet_placed';
