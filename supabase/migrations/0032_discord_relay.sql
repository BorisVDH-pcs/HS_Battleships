-- The Discord relay, finally built.
--
-- `game_events` has carried a `relayed_at` column since 0001 and architecture.md
-- has described this since the rebuild: rows are written first and relayed
-- second, so a failed post leaves a replayable backlog instead of a lost
-- message. This is that.
--
-- **Webhook, not a bot.** The traffic is one-way, so a bot's gateway connection,
-- its always-on process and its server-scoped token would all be paid for and
-- unused. A webhook is a URL. If one leaks, the damage is "someone can post in
-- that channel" rather than "someone can act as the game".
--
-- **Secret #2 protects itself here, and that is deliberate.** The message is
-- built from the event payload alone — the same data EventFeed.jsx renders —
-- and payloads carry `position` but never a tile's name or icon. So the relay
-- *cannot* leak the task list: there is nothing in its input to leak. The moment
-- someone joins discord_line() to `tiles` to make a message read better, that
-- guarantee is gone. Don't.
--
-- The URL itself is a credential and is NOT in this file. It lives in
-- `discord_webhooks`, which has RLS on and no policies at all — so anon and
-- authenticated get nothing, and only a definer function or the service role can
-- read it. It must never become a VITE_ variable: Vite inlines those into the
-- public bundle, which would hand every player the ability to post as the game.

create extension if not exists pg_net;

-- ============================================================
-- 1. Where to post
-- ============================================================

create table if not exists discord_webhooks (
  id         uuid primary key default gen_random_uuid(),
  game_id    uuid references games(id) on delete cascade,   -- null = every game
  label      text not null default 'general',
  url        text not null,
  enabled    boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table discord_webhooks is
  'Discord webhook URLs. Credentials: RLS on with no policies, so no client can read this.';

alter table discord_webhooks enable row level security;
revoke all on discord_webhooks from anon, authenticated;

-- Records what was sent in which request, so a failure can be reconciled and
-- replayed. Without this, "relayed" would mean "we asked pg_net to send it",
-- which is not the same thing.
create table if not exists discord_relay_log (
  request_id bigint primary key,
  game_id    uuid not null references games(id) on delete cascade,
  event_ids  uuid[] not null,
  created_at timestamptz not null default now()
);

alter table discord_relay_log enable row level security;
revoke all on discord_relay_log from anon, authenticated;

-- ============================================================
-- 2. One event, one line
-- ============================================================
-- Mirrors describe() in web/src/components/EventFeed.jsx. Payload only.

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

  -- Position to coordinate, the same way board.js does it.
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
    else p_event.type::text
  end;
end;
$$;

-- ============================================================
-- 3. Flush what has not been sent
-- ============================================================
-- Batched on purpose. A Discord webhook takes roughly five requests per five
-- seconds, and one shot can write three rows (fired, sunk, won). Posting per row
-- would spend the whole allowance on a single shot; posting the backlog as one
-- message spends one request and reads better besides.

create or replace function relay_pending(p_game_id uuid, p_limit int default 10)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_url   text;
  v_ids   uuid[];
  v_body  text;
  v_req   bigint;
begin
  select url into v_url from discord_webhooks
   where enabled and (game_id = p_game_id or game_id is null)
   order by game_id nulls last
   limit 1;
  if v_url is null then return 0; end if;

  with pending as (
    select * from game_events
     where game_id = p_game_id and relayed_at is null
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
    url     := v_url,
    body    := jsonb_build_object('content', v_body, 'username', 'HS Battleships'),
    headers := '{"Content-Type": "application/json"}'::jsonb
  ) into v_req;

  insert into discord_relay_log (request_id, game_id, event_ids)
  values (v_req, p_game_id, v_ids);

  update game_events set relayed_at = now() where id = any(v_ids);
  return array_length(v_ids, 1);
end;
$$;

-- ============================================================
-- 4. Send on commit
-- ============================================================
-- A DEFERRABLE constraint trigger, which fires at COMMIT rather than at the
-- insert. That matters: fire_tile() writes `shot_fired` and then `ship_sunk` in
-- one transaction, and a normal AFTER trigger would run on the first row before
-- the second exists — posting the shot, then the sinking, as two messages. At
-- commit both are visible, so relay_pending() picks up the pair and sends one.
--
-- The exception block is not decoration. This trigger runs inside the same
-- transaction as the move that caused it; an error here would roll back a
-- player's shot because a webhook was misconfigured.

create or replace function relay_on_commit()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    perform relay_pending(new.game_id);
  exception when others then
    raise warning 'discord relay failed: %', sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists trg_relay_game_events on game_events;
create constraint trigger trg_relay_game_events
  after insert on game_events
  deferrable initially deferred
  for each row execute function relay_on_commit();

-- ============================================================
-- 5. Reconcile, and replay what did not land
-- ============================================================
-- `relayed_at` is set when the request is queued, because that is the only
-- moment the sending transaction knows about. pg_net records the outcome later,
-- in net._http_response. This reads those outcomes back and un-marks anything
-- Discord refused, so the next flush retries it — which is the replayable
-- backlog architecture.md promises.

create or replace function relay_reconcile()
returns table (checked int, failed int)
language plpgsql security definer set search_path = public as $$
declare
  v_bad uuid[];
  v_n   int := 0;
begin
  select coalesce(array_agg(e), '{}'), count(*)
    into v_bad, v_n
    from (
      select unnest(l.event_ids) as e
        from discord_relay_log l
        join net._http_response r on r.id = l.request_id
       where r.status_code is null or r.status_code >= 300
    ) bad;

  if array_length(v_bad, 1) > 0 then
    update game_events set relayed_at = null where id = any(v_bad);
    delete from discord_relay_log
     where request_id in (
       select l.request_id from discord_relay_log l
        join net._http_response r on r.id = l.request_id
       where r.status_code is null or r.status_code >= 300
     );
  end if;

  return query select (select count(*)::int from discord_relay_log), coalesce(v_n, 0);
end;
$$;

-- Nothing here is for players. The trigger runs as definer; an organiser can
-- call the rest through the service role or the SQL editor.
revoke execute on function relay_pending(uuid, int)   from public, anon, authenticated;
revoke execute on function relay_reconcile()          from public, anon, authenticated;
revoke execute on function discord_line(game_events)  from public, anon, authenticated;
