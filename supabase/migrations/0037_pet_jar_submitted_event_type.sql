-- Adds the `pet_jar_submitted` event type, in its own committed migration.
-- Same reason as 0033/0034: enum value first, RPC that emits it (0039) after.

alter type event_type add value if not exists 'pet_jar_submitted';
