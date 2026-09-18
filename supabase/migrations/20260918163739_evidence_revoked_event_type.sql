-- Adds the `evidence_revoked` event type, in its own committed migration.
--
-- Same reason as 0008, 0012, 0015, 0018, 0028, 0033 and 0034: a new enum value
-- cannot be used by a function created in the same transaction. Splitting the
-- ALTER TYPE from the RPC that emits it (20260918163924) is what makes both
-- applyable.

alter type event_type add value if not exists 'evidence_revoked';
