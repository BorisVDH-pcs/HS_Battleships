-- Adds the `slot_freed` event type, in its own committed migration. Same
-- reason as 0033: enum value first, RPC that emits it (0035) after.

alter type event_type add value if not exists 'slot_freed';
