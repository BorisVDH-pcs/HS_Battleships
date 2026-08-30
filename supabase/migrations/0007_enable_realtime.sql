-- Publish game_events so Supabase Realtime actually broadcasts it.
--
-- Subscribing with supabase-js is only half of it: Postgres logical replication
-- will not emit a row unless its table is in the `supabase_realtime`
-- publication, and that publication starts empty. Without this, every client
-- subscribes successfully, receives nothing, and silently falls back to
-- refreshing only on its own actions — so a team never sees the opponent's
-- shots until it reloads. The failure is invisible: no error anywhere.
--
-- game_events is the only table clients subscribe to; everything else is
-- re-fetched in response to an event. It is world-readable by design and
-- carries no tile names (see 0001_init.sql), so publishing it leaks nothing.

alter publication supabase_realtime add table game_events;
