-- HS_Battleships — create a profile row automatically on sign-up
--
-- `team_members` references `profiles`, but Supabase Auth only ever writes to
-- `auth.users`. Without this trigger a freshly registered player has no profile,
-- so an admin could not add them to a team.
--
-- display_name comes from the sign-up metadata when the form supplies one,
-- otherwise from the local part of the email, so the feed always has a name.

create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, display_name, rsn)
  values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
      split_part(new.email, '@', 1)
    ),
    nullif(trim(new.raw_user_meta_data ->> 'rsn'), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Let a player edit their own display name / RSN. `profiles_self` already
-- covers UPDATE; this adds the matching row-visibility guard for writes.
drop policy if exists profiles_self on profiles;
create policy profiles_self on profiles
  for update using (id = auth.uid()) with check (id = auth.uid());
