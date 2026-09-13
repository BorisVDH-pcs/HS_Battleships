-- Which game an unassigned player sees.
--
-- Before this, a player on no team anywhere fell back to "whichever game is
-- newest by created_at" -- disconnected from which game is actually live.
-- Resetting an old game back to preparation, or creating a scratch game for
-- some other reason, would silently swap what every unrostered signup sees,
-- with no way for the admin to say otherwise.
--
-- is_featured makes that an explicit, admin-controlled choice instead. At
-- most one game is featured at a time -- admin_set_featured_game clears every
-- other one in the same statement, so there is never a moment with two, and
-- passing null just clears the flag everywhere.

alter table games add column if not exists is_featured boolean not null default false;

create or replace function admin_set_featured_game(p_game_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  update games set is_featured = (id = p_game_id) where is_featured or id = p_game_id;
end;
$$;

revoke execute on function admin_set_featured_game(uuid) from public, anon;
grant  execute on function admin_set_featured_game(uuid) to authenticated;
