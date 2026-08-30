-- Adds the `team_renamed` event type.
--
-- Kept separate from the function that uses it: PostgreSQL cannot use a newly
-- added enum value until the transaction that added it has committed.

alter type event_type add value if not exists 'team_renamed';
