-- A game can now carry a scheduled start time, so an admin can assign teams
-- and let captains place fleets well ahead of the event, while players who
-- are ready sit behind a countdown instead of a blank board.
--
-- Deliberately just a target time, not a trigger. `start_game` is unchanged:
-- it is still the only thing that ever moves a game to `active`, and it is
-- still admin-only and callable at any moment — before the target, exactly
-- at it, or well after it if the admin was not ready. Nothing in the database
-- reads `starts_at` to decide anything; it is display-only, surfaced to
-- players by the client's own countdown.

alter table games add column if not exists starts_at timestamptz;

create or replace function admin_set_start_time(p_game_id uuid, p_starts_at timestamptz)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  update games set starts_at = p_starts_at where id = p_game_id;
end;
$$;

revoke execute on function admin_set_start_time(uuid, timestamptz) from public, anon;
grant  execute on function admin_set_start_time(uuid, timestamptz) to authenticated;
