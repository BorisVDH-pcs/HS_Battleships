-- Team-scoped Discord channels, for the two event types that name a tile.
--
-- `discord_webhooks` only keyed on `game_id` before this: one row per game (or
-- one global row), so `relay_pending` picked a single "best" URL and sent
-- everything to it. `evidence_submitted` and `slot_freed` (0033-0035) are RLS-
-- scoped to one team for a reason — they must only ever reach that team's own
-- channel, never the shared one `shot_fired` etc. post to. So a webhook can now
-- also be scoped to a team, and the relay fans out to every matching webhook
-- instead of picking one winner.

alter table discord_webhooks add column if not exists team_id uuid
  references teams(id) on delete cascade;

comment on column discord_webhooks.team_id is
  'Null = the shared/general channel. Set = that team''s own private channel.';

-- ============================================================
-- 1. Which event types are team-private
-- ============================================================
-- A single source of truth so relay_pending and discord_line agree, and so a
-- future event type (pet jar, say) only has to be added in one place.

create or replace function is_team_private_event(p_type event_type)
returns boolean
language sql immutable as $$
  select p_type = any(array['evidence_submitted', 'slot_freed']::event_type[]);
$$;

-- ============================================================
-- 2. One event, one line — now covering the two new types
-- ============================================================
-- Still payload-only. It is safe for these two cases to read `tile_name` out
-- of the payload specifically because delivery is restricted downstream (RLS
-- on game_events, and the team-only routing in relay_pending below) — the
-- team reading this line already knows its own claimed tile's name.

create or replace function discord_line(p_event game_events)
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  v_team text;
  v_pos  int := (p_event.payload ->> 'position')::int;
  v_at   text;
begin
  select name into v_team from teams where id = p_event.team_id;
  v_team := coalesce(v_team, 'Someone');

  if v_pos is not null then
    v_at := ' at ' || chr(65 + ((v_pos - 1) % 10)) || (((v_pos - 1) / 10) + 1);
  else
    v_at := '';
  end if;

  return case p_event.type
    when 'fleet_placed'  then format('**%s**''s fleet is set.', v_team)
    when 'game_started'  then '**The game has begun** — fleets are locked.'
    when 'team_renamed'  then format('%s is now **%s**.',
                                     coalesce(p_event.payload ->> 'old_name', 'A team'),
                                     coalesce(p_event.payload ->> 'new_name', v_team))
    when 'tile_claimed'  then format('**%s** locked in a tile%s.', v_team, v_at)
    when 'claim_released' then format('An admin released **%s**''s tile%s.', v_team, v_at)
    when 'shot_fired'    then format('**%s** fired%s — %s', v_team, v_at,
                                     case when p_event.payload ->> 'result' = 'hit'
                                          then '**HIT**' else 'miss.' end)
    when 'ship_sunk'     then format(':boom: **%s** sank a %s-tile ship!',
                                     v_team, p_event.payload ->> 'size')
    when 'game_won'      then format(':trophy: **%s** wins — the enemy fleet is gone.', v_team)
    when 'game_reset'    then case when (p_event.payload ->> 'fleets_cleared')::boolean
                                   then 'The game has been reset — fleets need placing again.'
                                   else 'The game has been reset. Fleets are unchanged.' end
    when 'score_adjusted' then
      case when (p_event.payload ->> 'reverted')::boolean
           then format('An adjustment to **%s** was reverted.', v_team)
           else format('**%s** %s %s point(s).', v_team,
                       case when (p_event.payload ->> 'delta')::int >= 0 then 'gained' else 'lost' end,
                       abs((p_event.payload ->> 'delta')::int)) end
    when 'evidence_submitted' then format('**%s** submitted proof for **%s** (%s/%s) — %s tile(s) left to fire.',
                                     coalesce(p_event.payload ->> 'uploaded_by_name', v_team),
                                     coalesce(p_event.payload ->> 'tile_name', 'a tile'),
                                     p_event.payload ->> 'evidence_count',
                                     p_event.payload ->> 'required_evidence',
                                     p_event.payload ->> 'tiles_left_to_fire')
    when 'slot_freed'    then 'A slot is free to claim.'
    else p_event.type::text
  end;
end;
$$;

-- ============================================================
-- 3. Flush what has not been sent — one pass per matching webhook
-- ============================================================

create or replace function relay_flush(
  p_game_id       uuid,
  p_team_id       uuid,   -- null for the general channel
  p_url           text,
  p_limit         int,
  p_team_channel  boolean
)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_ids  uuid[];
  v_body text;
  v_req  bigint;
begin
  with pending as (
    select * from game_events
     where game_id = p_game_id and relayed_at is null
       and (case when p_team_channel
                 then is_team_private_event(type) and team_id = p_team_id
                 else not is_team_private_event(type) end)
     order by created_at
     limit p_limit
  )
  select array_agg(id order by created_at),
         string_agg(discord_line(pending.*), E'\n' order by created_at)
    into v_ids, v_body
    from pending;

  if v_ids is null then return 0; end if;

  -- Fire-and-forget by design: pg_net queues the request and the transaction
  -- does not wait on Discord. A shot must not be slower, or fail, because a
  -- chat service is having a bad day.
  select net.http_post(
    url     := p_url,
    body    := jsonb_build_object('content', v_body, 'username', 'HS Battleships'),
    headers := '{"Content-Type": "application/json"}'::jsonb
  ) into v_req;

  insert into discord_relay_log (request_id, game_id, event_ids)
  values (v_req, p_game_id, v_ids);

  update game_events set relayed_at = now() where id = any(v_ids);
  return array_length(v_ids, 1);
end;
$$;

create or replace function relay_pending(p_game_id uuid, p_limit int default 10)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_url   text;
  v_total int := 0;
  v_team  record;
begin
  -- The shared channel: same "best row" pick as before (game-specific row
  -- beats the null-game fallback), but it now only ever carries event types
  -- that were never secret in the first place.
  select url into v_url from discord_webhooks
   where enabled and team_id is null and (game_id = p_game_id or game_id is null)
   order by game_id nulls last
   limit 1;
  if v_url is not null then
    v_total := v_total + relay_flush(p_game_id, null, v_url, p_limit, false);
  end if;

  -- Each team's own channel, if it has one configured.
  for v_team in select id from teams where game_id = p_game_id loop
    select url into v_url from discord_webhooks
     where enabled and team_id = v_team.id and (game_id = p_game_id or game_id is null)
     order by game_id nulls last
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

revoke execute on function relay_flush(uuid, uuid, text, int, boolean) from public, anon, authenticated;
revoke execute on function relay_pending(uuid, int)                    from public, anon, authenticated;
revoke execute on function discord_line(game_events)                   from public, anon, authenticated;
revoke execute on function is_team_private_event(event_type)           from public, anon;
grant  execute on function is_team_private_event(event_type)           to authenticated;
