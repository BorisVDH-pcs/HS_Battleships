-- HS_Battleships — scoring and the scoreboard
--
-- Score is DERIVED, in the same spirit as `ship_status`: the board already
-- records everything a score is made of, so storing a running total would only
-- create something that can drift. `score_events` keeps its original job — the
-- sheet's "+1" button — as an audit trail of manual adjustments layered on top.
--
--   total = tiles_fired * points_per_tile
--         + hits        * points_per_hit
--         + ships_sunk  * points_per_sink
--         + sum(manual adjustments)
--
-- The weights live on the game rather than in this file. The spreadsheet scored
-- one point per completed tile and nothing else, so that is the default; an
-- organiser who wants to reward hits or sinkings can change it per event
-- without a migration.

-- ============================================================
-- 1. Scoring weights
-- ============================================================

alter table games
  add column if not exists points_per_tile smallint not null default 1,
  add column if not exists points_per_hit  smallint not null default 0,
  add column if not exists points_per_sink smallint not null default 0;

-- ============================================================
-- 2. `reason` is free text, so it must not be world-readable
-- ============================================================
-- The original policy was `using (true)`. Every other public channel in this
-- schema is structurally incapable of naming a tile (see the note on
-- `game_events` in 0001) — but `reason` is whatever an admin types, and
-- "Sank them on Barrows chest" on a shared grid tells the other team what sits
-- at that coordinate on their own board. So the rows go team-scoped, and the
-- totals reach everyone through the aggregate view below instead.

drop policy if exists scores_read on score_events;

create policy scores_own_team_or_admin on score_events
  for select using (team_id in (select my_team_ids()) or is_admin());

-- ============================================================
-- 3. The scoreboard
-- ============================================================
-- Security definer (like `tiles_for_me`) so it can total BOTH teams' rows while
-- the base table stays team-scoped. It exposes counts and totals only, never
-- `reason`, so there is nothing here the feed does not already broadcast:
-- every shot and its result is public in `game_events` by design.

create or replace view team_scores
with (security_invoker = false) as
with base as (
  select
    t.game_id,
    t.id   as team_id,
    t.name as team_name,
    (select count(*) from tile_claims c
      where c.team_id = t.id and c.status = 'fired')::int as tiles_fired,
    (select count(*) from tile_claims c
      where c.team_id = t.id and c.status = 'fired' and c.result = 'hit')::int as hits,
    (select count(*) from tile_claims c
      where c.team_id = t.id and c.status = 'fired' and c.result = 'miss')::int as misses,
    (select count(*) from tile_claims c
      where c.team_id = t.id and c.status = 'active')::int as active_tiles,
    -- Enemy ships this team has finished off: every cell of the ship carries a
    -- hit fired by THIS team. Counted from the base tables rather than through
    -- `ship_status`, which is security_invoker and would resolve against the
    -- wrong role from inside a definer view.
    (select count(*) from ships s
       join teams et on et.id = s.team_id
      where et.game_id = t.game_id
        and et.id <> t.id
        and not exists (
          select 1 from ship_cells sc
           where sc.ship_id = s.id
             and not exists (
               select 1 from tiles ti
                 join tile_claims c on c.tile_id = ti.id
                where ti.game_id = t.game_id
                  and ti.row = sc.row and ti.col = sc.col
                  and c.team_id = t.id
                  and c.status = 'fired' and c.result = 'hit'
             )
        ))::int as ships_sunk,
    (select coalesce(sum(se.delta), 0) from score_events se
      where se.team_id = t.id)::int as adjustments
  from teams t
)
select
  b.*,
  (b.tiles_fired * g.points_per_tile
   + b.hits       * g.points_per_hit
   + b.ships_sunk * g.points_per_sink
   + b.adjustments)::int as total
from base b
join games g on g.id = b.game_id;

grant select on team_scores to authenticated;

-- ============================================================
-- 4. Admin RPCs
-- ============================================================

-- The "+1" button. `p_profile_id` is optional and is only ever credit in the
-- audit trail — points belong to the team.
create or replace function admin_adjust_score(
  p_team_id    uuid,
  p_delta      integer,
  p_reason     text,
  p_profile_id uuid default null
) returns score_events
language plpgsql security definer set search_path = public as $$
declare
  v_game_id uuid;
  v_row     score_events;
begin
  if not is_admin() then raise exception 'Admins only'; end if;

  if p_delta = 0 then
    raise exception 'An adjustment of zero changes nothing';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'Give the adjustment a reason — it is the audit trail';
  end if;

  select game_id into v_game_id from teams where id = p_team_id;
  if v_game_id is null then
    raise exception 'No such team';
  end if;

  insert into score_events (team_id, profile_id, delta, reason)
  values (p_team_id, p_profile_id, p_delta, btrim(p_reason))
  returning * into v_row;

  -- The delta, never the reason: this feed is read by both teams. Its real job
  -- is to make the scoreboard update live — the app refetches on any game_event.
  insert into game_events (game_id, team_id, type, payload)
  values (v_game_id, p_team_id, 'score_adjusted',
          jsonb_build_object('delta', p_delta, 'by', auth.uid()));

  return v_row;
end;
$$;

-- Undo. Deleting the row is right rather than posting a compensating entry:
-- these are corrections to a live scoreboard on a raid night, not ledger
-- postings, and a mistyped "+50" should not stay on the record forever.
create or replace function admin_delete_score_event(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_game_id uuid;
  v_team_id uuid;
  v_delta   integer;
begin
  if not is_admin() then raise exception 'Admins only'; end if;

  select se.team_id, se.delta, t.game_id
    into v_team_id, v_delta, v_game_id
    from score_events se join teams t on t.id = se.team_id
   where se.id = p_id;

  if v_team_id is null then
    raise exception 'No such score adjustment';
  end if;

  delete from score_events where id = p_id;

  insert into game_events (game_id, team_id, type, payload)
  values (v_game_id, v_team_id, 'score_adjusted',
          jsonb_build_object('delta', -v_delta, 'reverted', true, 'by', auth.uid()));
end;
$$;

-- Admins see every adjustment, reasons included, across both teams.
create or replace function admin_list_score_events(p_game_id uuid)
returns table (
  id           uuid,
  team_id      uuid,
  team_name    text,
  profile_id   uuid,
  display_name text,
  delta        integer,
  reason       text,
  created_at   timestamptz
)
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  return query
    select se.id, se.team_id, t.name, se.profile_id, p.display_name,
           se.delta, se.reason, se.created_at
      from score_events se
      join teams t on t.id = se.team_id
      left join profiles p on p.id = se.profile_id
     where t.game_id = p_game_id
     order by se.created_at desc;
end;
$$;

create or replace function admin_set_scoring(
  p_game_id   uuid,
  p_per_tile  smallint,
  p_per_hit   smallint,
  p_per_sink  smallint
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;

  update games
     set points_per_tile = p_per_tile,
         points_per_hit  = p_per_hit,
         points_per_sink = p_per_sink
   where id = p_game_id;

  if not found then raise exception 'No such game'; end if;
end;
$$;

-- ============================================================
-- 5. Grants — `grant to authenticated` does not remove PUBLIC's implicit
--    EXECUTE, so each one has to be revoked first. See 0003.
-- ============================================================

revoke execute on function admin_adjust_score(uuid, integer, text, uuid)         from public, anon;
revoke execute on function admin_delete_score_event(uuid)                        from public, anon;
revoke execute on function admin_list_score_events(uuid)                         from public, anon;
revoke execute on function admin_set_scoring(uuid, smallint, smallint, smallint) from public, anon;

grant execute on function admin_adjust_score(uuid, integer, text, uuid)         to authenticated;
grant execute on function admin_delete_score_event(uuid)                        to authenticated;
grant execute on function admin_list_score_events(uuid)                         to authenticated;
grant execute on function admin_set_scoring(uuid, smallint, smallint, smallint) to authenticated;
