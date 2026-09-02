-- Adds the `pet_jar_spent` event type, in its own committed migration.
-- Same reason as 0037: enum value first, RPC that emits it (0039) after.

alter type event_type add value if not exists 'pet_jar_spent';
