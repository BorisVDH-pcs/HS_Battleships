-- What the other team is allowed to learn from a revoke.
--
-- The rule asked for: the enemy may know that a shot was taken back. They may
-- not know which square, which tile, or what was on it. Everything that names
-- any of those stays with the team it happened to.
--
-- Before this, two things told them more than that:
--
--   1. Nothing at all was announced, which sounds safe and is not. A withdrawn
--      shot is VISIBLE to the enemy — an un-fired claim leaves `enemyShots`,
--      so the hit or miss mark disappears off their own fleet. They were being
--      shown a change with no cause, which invites exactly the speculation the
--      secrecy is meant to prevent.
--   2. Locking the parked tile back in emitted `tile_claimed` — global, and it
--      names the square. The enemy would see the same coordinate announced
--      twice, which is a reliable tell that something was rolled back there.
--
-- So the announcement is split by audience rather than trimmed to the weakest
-- reader:
--
--   evidence_revoked   team-private, unchanged — tile, square, drop, counts.
--   shot_withdrawn     GLOBAL, and deliberately almost empty: the team that
--                      fired, and nothing else.
--   tile_relocked      team-private — who picked it back up, and where.
--
-- `shot_withdrawn` is emitted only when the shot actually comes back. A revoke
-- that leaves the claim fired (the tile still meets its target without that
-- piece) changes nothing the enemy can see, so announcing it would hand them a
-- fact they had no other way to get.

-- ============================================================
-- 1. tile_relocked is the team's business
-- ============================================================
-- shot_withdrawn is NOT in this list: it is the one thing the other team is
-- meant to see.
--
-- The client keeps a copy of this list (web/src/components/EventFeed.jsx), and
-- it has drifted once already — `evidence_revoked` was added here and missed
-- there, so revokes were tagged [GLOBAL] on a screen where this policy was
-- correctly hiding them. Anything added here goes there in the same change.

create or replace function is_team_private_event(p_type event_type)
returns boolean
language sql immutable set search_path = '' as $$
  select p_type = any(array[
    'evidence_submitted',
    'evidence_revoked',
    'tile_relocked',
    'slot_freed',
    'pet_jar_submitted',
    'pet_jar_spent'
  ]::public.event_type[]);
$$;

-- ============================================================
-- 2. Re-locking is announced to the team only
-- ============================================================
-- Body is 20260918170330's, with one change: the event emitted depends on
-- whether this was a fresh claim or a parked tile being picked back up.
-- `tile_claimed` is global and names the square, which is correct for a first
-- claim — the enemy learning that a square is spoken for is part of the game —
-- and wrong for a second one, where it only marks the revoke.

create or replace function claim_tile(p_tile_id uuid)
returns tile_claims
language plpgsql security definer set search_path = public as $$
declare
  v_team_id  uuid;
  v_tile     tiles%rowtype;
  v_claim    tile_claims;
  v_existing tile_claims%rowtype;
  v_relock   boolean := false;
begin
  select * into v_tile from tiles where id = p_tile_id;
  if not found then
    raise exception 'No such tile';
  end if;

  v_team_id := my_team_in_game(v_tile.game_id);

  if v_team_id is null then
    raise exception 'You are not a member of a team in this game';
  end if;

  if (select status from games where id = v_tile.game_id) <> 'active' then
    raise exception 'The game is not active';
  end if;

  select * into v_existing from tile_claims
   where team_id = v_team_id and tile_id = p_tile_id for update;

  if found then
    if v_existing.status = 'fired' then
      raise exception 'Your team has already fired at that square';
    elsif v_existing.paused_at is null then
      raise exception 'Your team already has that tile locked in';
    end if;

    v_relock := true;

    update tile_claims
       set paused_at = null, claimed_by = auth.uid(), claimed_at = now()
     where id = v_existing.id
    returning * into v_claim;
  else
    insert into tile_claims (team_id, tile_id, claimed_by)
    values (v_team_id, p_tile_id, auth.uid())
    returning * into v_claim;
  end if;

  if v_relock then
    -- Team-private, so it may name the tile as well as the square.
    insert into game_events (game_id, team_id, type, payload)
    values (v_tile.game_id, v_team_id, 'tile_relocked',
            jsonb_build_object('tile_id', v_tile.id, 'position', v_tile.position,
                               'tile_name', v_tile.name, 'by', auth.uid(),
                               'by_name', (select display_name from profiles
                                            where id = auth.uid())));
  else
    insert into game_events (game_id, team_id, type, payload)
    values (v_tile.game_id, v_team_id, 'tile_claimed',
            jsonb_build_object('tile_id', v_tile.id,
                               'position', v_tile.position, 'by', auth.uid()));
  end if;

  return v_claim;
end;
$$;

revoke execute on function claim_tile(uuid) from public, anon;
grant  execute on function claim_tile(uuid) to authenticated;

-- ============================================================
-- 3. The revoke emits the public half too
-- ============================================================
-- Body is 20260918170330's, with one insert added inside the same block, so
-- the dry run unwinds it along with everything else and a rolled-back
-- rehearsal still sends nothing.

create or replace function admin_revoke_evidence(
  p_evidence_id uuid,
  p_dry_run     boolean default false
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_ev        tile_evidence%rowtype;
  v_claim     tile_claims%rowtype;
  v_tile      tiles%rowtype;
  v_game      games%rowtype;
  v_team      text;
  v_enemy_id  uuid;
  v_by        text;
  v_opt_label text;
  v_was_fired boolean;
  v_result    shot_result;
  v_ship_id   uuid;
  v_ship_size int := 0;
  v_was_sunk  boolean := false;
  v_refloated boolean := false;
  v_reopened  boolean := false;
  v_unfired   boolean := false;
  v_rings     int := 0;
  v_left      int := 0;
  v_points    int := 0;
  v_active    int := 0;
  v_limit     smallint;
  v_still     boolean;
  v_out       jsonb;
begin
  if not is_admin() then raise exception 'Admins only'; end if;

  select * into v_ev from tile_evidence where id = p_evidence_id;
  if not found then raise exception 'No such piece of evidence'; end if;

  select * into v_claim from tile_claims where id = v_ev.claim_id for update;
  if not found then raise exception 'No such tile claim'; end if;

  select * into v_tile from tiles  where id = v_claim.tile_id;
  select * into v_game from games  where id = v_tile.game_id;
  select name into v_team from teams where id = v_claim.team_id;
  select id into v_enemy_id from teams
   where game_id = v_game.id and id <> v_claim.team_id;

  if v_ev.option_id is not null then
    select label into v_opt_label from tile_options where id = v_ev.option_id;
  end if;

  select display_name into v_by from profiles where id = auth.uid();

  v_was_fired := v_claim.status = 'fired';
  v_result    := v_claim.result;

  if v_was_fired and v_result = 'hit' then
    select sc.ship_id into v_ship_id
      from ship_cells sc
     where sc.team_id = v_enemy_id and sc.row = v_tile.row and sc.col = v_tile.col;

    if v_ship_id is not null then
      select count(distinct (sc.row, sc.col))::int into v_ship_size
        from ship_cells sc where sc.ship_id = v_ship_id;
      v_was_sunk := ship_is_sunk(v_ship_id, v_claim.team_id);
    end if;
  end if;

  begin
    delete from tile_evidence where id = p_evidence_id;

    select count(*), coalesce(sum(points), 0)
      into v_left, v_points
      from tile_evidence where claim_id = v_claim.id;

    v_still := claim_is_complete(v_claim.id);

    if v_was_fired and not v_still then
      v_unfired := true;

      update tile_claims
         set status = 'active', result = null, fired_by = null, fired_at = null,
             paused_at = now()
       where id = v_claim.id;

      if v_was_sunk and not ship_is_sunk(v_ship_id, v_claim.team_id) then
        v_refloated := true;

        with gone as (
          delete from tile_claims c
           using tiles t
           where c.tile_id  = t.id
             and c.team_id  = v_claim.team_id
             and c.status   = 'fired'
             and c.result   = 'miss'
             and c.claimed_by is null
             and c.fired_by   is null
             and not exists (select 1 from tile_evidence e where e.claim_id = c.id)
             and exists (
                   select 1 from ship_cells h
                    where h.ship_id = v_ship_id
                      and abs(h.row - t.row) <= 1
                      and abs(h.col - t.col) <= 1)
             and not exists (
                   select 1 from ship_cells h2
                    where h2.team_id  = v_enemy_id
                      and h2.ship_id <> v_ship_id
                      and abs(h2.row - t.row) <= 1
                      and abs(h2.col - t.col) <= 1
                      and ship_is_sunk(h2.ship_id, v_claim.team_id))
          returning 1
        )
        select count(*)::int into v_rings from gone;
      end if;

      if v_game.status = 'finished'
         and v_game.winner_team_id = v_claim.team_id
         and exists (select 1 from ships s
                      where s.team_id = v_enemy_id
                        and not ship_is_sunk(s.id, v_claim.team_id)) then
        update games
           set status = 'active', winner_team_id = null, ended_at = null
         where id = v_game.id;
        v_reopened := true;
      end if;
    end if;

    select count(*)::int into v_active from tile_claims
     where team_id = v_claim.team_id and status = 'active' and paused_at is null;
    v_limit := v_game.max_active_tiles;

    v_out := jsonb_build_object(
      'evidence_id',       p_evidence_id,
      'claim_id',          v_claim.id,
      'dry_run',           p_dry_run,
      'position',          v_tile.position,
      'tile_name',         v_tile.name,
      'completion',        v_tile.completion::text,
      'required_evidence', coalesce(v_tile.required_evidence, 1),
      'team_id',           v_claim.team_id,
      'team_name',         v_team,
      'submitted_by',      v_ev.uploaded_by_name,
      'submitted_at',      v_ev.created_at,
      'option_label',      v_opt_label,
      'points_removed',    v_ev.points,
      'evidence_left',     v_left,
      'points_left',       v_points,
      'still_complete',    v_still,
      'was_fired',         v_was_fired,
      'shot_result',       v_result,
      'unfired',           v_unfired,
      'parked',            v_unfired,
      -- What the other team will be told. Surfaced so the confirm dialog can
      -- say it: an organiser should not have to guess who sees what.
      'announced_to_all',  v_unfired,
      'ship_refloated',    v_refloated,
      'ship_size',         case when v_refloated then v_ship_size end,
      'reveals_withdrawn', v_rings,
      'game_reopened',     v_reopened,
      'active_tiles',      v_active,
      'max_active_tiles',  v_limit,
      'over_slot_limit',   false
    );

    if p_dry_run then
      raise exception 'dry run complete' using errcode = 'HS001';
    end if;

    -- The team's own account of it: everything.
    insert into game_events (game_id, team_id, type, payload)
    values (v_game.id, v_claim.team_id, 'evidence_revoked',
            jsonb_build_object(
              'claim_id',          v_claim.id,
              'position',          v_tile.position,
              'tile_name',         v_tile.name,
              'option_label',      v_opt_label,
              'points_removed',    v_ev.points,
              'submitted_by_name', v_ev.uploaded_by_name,
              'evidence_count',    v_left,
              'required_evidence', coalesce(v_tile.required_evidence, 1),
              'unfired',           v_unfired,
              'parked',            v_unfired,
              'ship_refloated',    v_refloated,
              'reveals_withdrawn', v_rings,
              'game_reopened',     v_reopened,
              'by',                auth.uid(),
              'by_name',           coalesce(v_by, 'an admin')
            ));

    -- The other team's: that it happened, and who to. No position, no tile
    -- name, no drop, no result — every one of those is the thing being kept
    -- back, and a payload field is as readable as a rendered line.
    --
    -- Only when the shot actually came back. If the claim is still complete
    -- without that piece, nothing the enemy can see has changed, and saying so
    -- would tell them something they had no other way to learn.
    if v_unfired then
      insert into game_events (game_id, team_id, type, payload)
      values (v_game.id, v_claim.team_id, 'shot_withdrawn',
              jsonb_build_object('by_name', coalesce(v_by, 'an admin')));
    end if;

  exception
    when sqlstate 'HS001' then
      null;
  end;

  return v_out;
end;
$$;

revoke execute on function admin_revoke_evidence(uuid, boolean) from public, anon;
grant  execute on function admin_revoke_evidence(uuid, boolean) to authenticated;

-- ============================================================
-- 4. The two new lines, for the two channels
-- ============================================================
-- Body verbatim from 20260918170330 plus two branches. `shot_withdrawn` lands
-- in the general channel because it is not team-private; `tile_relocked` goes
-- only to the team's own, by the same routing.
--
-- Note what the shot_withdrawn line does NOT interpolate: v_at is in scope and
-- would be the natural thing to append, and appending it would undo the whole
-- migration.

create or replace function discord_line(p_event game_events)
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  v_team text;
  v_pos  int := (p_event.payload ->> 'position')::int;
  v_at   text;
  v_img  text := nullif(btrim(coalesce(p_event.payload ->> 'image_url', '')), '');
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
    when 'tile_relocked' then format('**%s** locked **%s**%s back in.',
                                     coalesce(p_event.payload ->> 'by_name', v_team),
                                     coalesce(p_event.payload ->> 'tile_name', 'a tile'), v_at)
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
    when 'evidence_submitted' then format('**%s** submitted proof for **%s** (%s/%s).',
                                     coalesce(p_event.payload ->> 'uploaded_by_name', v_team),
                                     coalesce(p_event.payload ->> 'tile_name', 'a tile'),
                                     p_event.payload ->> 'evidence_count',
                                     p_event.payload ->> 'required_evidence')
                                   || case when v_img is not null then E'\n' || v_img else '' end
    when 'evidence_revoked' then format(
        ':leftwards_arrow_with_hook: An admin withdrew %s''s submission for **%s**%s — now %s/%s.%s',
        coalesce(p_event.payload ->> 'submitted_by_name', v_team),
        coalesce(p_event.payload ->> 'tile_name', 'a tile'),
        coalesce(' (' || (p_event.payload ->> 'option_label') || ')', ''),
        p_event.payload ->> 'evidence_count',
        p_event.payload ->> 'required_evidence',
        case when (p_event.payload ->> 'parked')::boolean
             then ' The shot is taken back and the tile is unlocked — **lock it in again** to finish it.'
             else '' end
        || case when (p_event.payload ->> 'ship_refloated')::boolean
                then ' A ship is no longer sunk.' else '' end
        || case when (p_event.payload ->> 'game_reopened')::boolean
                then ' **The game has been reopened.**' else '' end)
    when 'shot_withdrawn' then format(
        ':leftwards_arrow_with_hook: One of **%s**''s shots has been withdrawn by an organiser.', v_team)
    when 'slot_freed'    then 'An active tile is available now. Lock in another target.'
    when 'pet_jar_submitted' then format(':jar: **%s** submitted a pet/jar — %s pet jar preview(s) now.',
                                     coalesce(p_event.payload ->> 'submitted_by_name', v_team),
                                     p_event.payload ->> 'pet_jar_count')
                                   || case when v_img is not null then E'\n' || v_img else '' end
    when 'pet_jar_spent' then format(':mag: A pet jar preview was spent on **%s** — %s left.',
                                     coalesce(p_event.payload ->> 'tile_name', 'a tile'),
                                     p_event.payload ->> 'pet_jar_count')
    else p_event.type::text
  end;
end;
$$;

revoke execute on function discord_line(game_events) from public, anon, authenticated;
