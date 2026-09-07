-- Is that game ready, without opening it?
--
-- The setup checklist is the best thing on the console and it lives one click
-- too deep: it is computed for the game currently open, so with three games
-- queued the only way to learn which is ready is to open each in turn. The
-- badge that fixes it needs three numbers per game, and all three are behind
-- RLS the client cannot get past:
--
--   tiles      — `tiles_no_direct_read` is USING (false). No direct select for
--                anybody, admin included; the board is secret #2 and the only
--                way in is an RPC that redacts.
--   ship_cells — scoped to `my_team_ids()`, and an admin has no team, so a
--                direct read returns nothing rather than everything.
--   webhooks   — admin-gated the same way.
--
-- The alternative was looping the per-game RPCs over every game, which is the
-- N-queries-per-action shape the console was just taken off. One aggregate
-- covers every game in one round trip.
--
-- Counts only. No tile names, no ship coordinates, no webhook URLs — nothing
-- here is a fact about a board that a leak would matter for, which is what
-- lets it be one query over every game rather than a redacting read per game.

create or replace function admin_game_readiness()
returns table (
  game_id               uuid,
  tile_count            integer,
  tiles_needed          integer,
  teams_with_full_fleet integer,
  webhook_count         integer
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;

  return query
    select
      g.id,
      (select count(*)::int from tiles t where t.game_id = g.id),
      (g.grid_size * g.grid_size)::int,
      -- A team's fleet is complete when it has as many distinct hulls placed
      -- as the game's fleet has entries. Counting distinct ship_id rather than
      -- cells, because a five-hull fleet is seventeen cells and the checklist
      -- asks about hulls.
      (select count(*)::int
         from teams te
        where te.game_id = g.id
          and (select count(distinct sc.ship_id)
                 from ship_cells sc where sc.team_id = te.id)
              = coalesce(array_length(g.fleet, 1), 0)),
      (select count(*)::int from discord_webhooks w where w.game_id = g.id)
    from games g;
end;
$$;

revoke execute on function admin_game_readiness() from public, anon;
grant  execute on function admin_game_readiness() to authenticated;
