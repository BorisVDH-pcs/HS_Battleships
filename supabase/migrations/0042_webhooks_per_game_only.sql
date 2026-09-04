-- Webhooks are per game, and the admin panel is the whole truth.
--
-- `discord_webhooks.game_id` has been nullable since 0032, documented there as
-- "null = every game", and relay_pending honoured that with
-- `(game_id = p_game_id or game_id is null)`. Two things then drifted apart:
--
--   * relay_pending MATCHED a null-game row for every game;
--   * admin_list_webhooks (0040) lists `where w.game_id = p_game_id`, so it
--     never returned one.
--
-- The table also has RLS on with no policies and is revoked from anon and
-- authenticated (0032), so admin_list_webhooks is the only way a client can
-- read it. A null-game row was therefore invisible in every game's panel and
-- removable from none of them, while relaying every event in the instance.
--
-- Found the hard way: tiles claimed in a game whose webhook panel was empty
-- still posted to Discord, from a row no screen in the app could show. Exactly
-- one such row existed, created by hand before the panel could set a game.
--
-- The rule is now what the panel always implied: what you see for a game is
-- what fires for that game, and an empty panel means silence. Enforced in three
-- places so it cannot drift again -- the lookup no longer falls back, the
-- orphans are cleared, and the column will not accept another one.

-- 1. Route on the game, and only the game.
create or replace function relay_pending(p_game_id uuid, p_limit int default 10)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_url   text;
  v_total int := 0;
  v_team  record;
begin
  -- The shared channel for this game, and only this game.
  select url into v_url from discord_webhooks
   where enabled and team_id is null and game_id = p_game_id
   limit 1;
  if v_url is not null then
    v_total := v_total + relay_flush(p_game_id, null, v_url, p_limit, false);
  end if;

  -- Each team's own channel, if it has one configured for this game.
  for v_team in select id from teams where game_id = p_game_id loop
    select url into v_url from discord_webhooks
     where enabled and team_id = v_team.id and game_id = p_game_id
     limit 1;
    if v_url is not null then
      v_total := v_total + relay_flush(p_game_id, v_team.id, v_url, p_limit, true);
    end if;
  end loop;

  -- Team-private events with no configured team webhook are left pending —
  -- the same "no webhook, nothing marked" behaviour the general channel has
  -- always had when unconfigured. They will not spam anywhere; they just wait.
  return v_total;
end;
$$;

-- `create or replace` keeps the existing grants, but restate the revoke so a
-- database built from these files in order ends up identical to this one.
revoke execute on function relay_pending(uuid, int) from public, anon, authenticated;

-- 2. Clear the orphans. After the change above they can never match a game, so
--    they are unreachable rows still holding a live credential -- worse than
--    absent. A channel cleared here is re-added from the panel in seconds, and
--    the URL itself is always recoverable from the Discord channel's own
--    integration settings.
delete from discord_webhooks where game_id is null;

-- 3. Refuse the next one. admin_set_webhook has always been given a game id, so
--    this constrains nothing the app does -- only the hand-written insert that
--    created the orphan in the first place.
alter table discord_webhooks alter column game_id set not null;

comment on column discord_webhooks.game_id is
  'The game this webhook serves. Never null: relay_pending matches it exactly, '
  'so a game''s admin panel lists precisely what will fire for it. See 0042.';
