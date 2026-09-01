-- Adds the `claim_released` event type, in its own committed migration.
--
-- Same reason as 0008, 0012, 0015 and 0018: a new enum value cannot be used by
-- a function created in the same transaction. Splitting the ALTER TYPE from the
-- RPC that emits it (0029) is what makes both applyable.

alter type event_type add value if not exists 'claim_released';
