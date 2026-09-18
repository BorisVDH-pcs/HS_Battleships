-- Take one submission back.
--
-- The gap this fills, in the organiser's words: a team completing "Infernal
-- cape, fire cape and quiver" picks the wrong drop out of the list, presses
-- submit, and banks the wrong number of points. Until now nothing could undo
-- that one screenshot. `admin_release_claim` (0029) throws the WHOLE claim
-- away -- every screenshot on it, back to an unclaimed square -- and refuses
-- outright once the tile has fired. So the fix for a single mis-picked drop
-- was either to destroy five correct submissions alongside it, or to write SQL
-- on the night.
--
-- This revokes ONE piece of evidence and puts the claim back exactly where it
-- stood before that piece arrived, so the team can submit again against the
-- right drop.
--
-- ---- why a piece of evidence can be removed at all ----
--
-- 0021 made `tile_evidence` append-only and said why: evidence is the record
-- of why a shot counted, and a team able to retract it afterwards makes that
-- record worthless. None of that changes. There is still no delete policy on
-- the table, so RLS refuses a delete to every player; this is a definer
-- function gated on `is_admin()`, and it writes an `evidence_revoked` event
-- naming what went and who took it. The team cannot retract. An organiser can,
-- and is on the record for it.
--
-- ---- what has to be unwound, and what unwinds itself ----
--
-- Most of it needs no help, because almost nothing about a shot is stored:
--
--   * `team_scores` (0020) counts fired claims and derives everything else.
--   * `ship_status` (0026) counts DISTINCT hit cells against the hull's own
--     cells. Nothing anywhere records "sunk".
--   * `claim_is_complete` and `evidence_refusal` read `tile_evidence` rows and
--     nothing else, so deleting a row reopens a closed set and hands back a
--     spent `max_times` repeat with no further action.
--
-- So reverting `tile_claims` to active is most of the job. Three things do
-- need doing by hand, and all three are reported before the press:
--
--   1. THE RING. When a hull sinks, `fire_tile` inserts an already-fired
--      'miss' claim on every square around it -- guaranteed water by the
--      no-touching rule, so the sinking team gets them free. Leave those
--      behind after a refloat and the squares are worse than revealed: the
--      `unique (team_id, tile_id)` constraint means that team can now never
--      claim them, and each one counts as a miss forever. They are deleted.
--      Identified by what only `fire_tile` produces -- a fired miss with no
--      `claimed_by`, no `fired_by` and no evidence -- and kept if they also
--      ring a DIFFERENT hull that is still sunk.
--   2. THE WIN. A shot that emptied the board set `games.status = 'finished'`
--      and a `winner_team_id`. Undoing that shot has to reopen the game, or
--      the match stays over with a fleet afloat.
--   3. THE SLOT. The active-tile limit is a BEFORE INSERT trigger (0001), so
--      an UPDATE back to 'active' walks straight past it. A team on three of
--      three can be handed a fourth this way. Allowed rather than refused --
--      the alternative is an organiser who cannot fix a mistake because the
--      team is busy -- but it is in the preview, so nobody does it unaware.
--
-- ---- the claim is only un-fired if it is genuinely unfinished ----
--
-- Not every revoke undoes a shot. A `points` tile that needed 10 and banked 12
-- is still done at 10 once a wrong 2-point pick is taken off it, and un-firing
-- it would withdraw a shot the team had legitimately earned. So the rule is
-- `claim_is_complete()` asked again after the delete -- the same authority
-- `add_evidence` asks before firing, rather than a second opinion written
-- here. Still complete means the row goes and nothing else moves.
--
-- ---- no refusals, by decision ----
--
-- Every case is permitted: a miss, a hit, a sinking, a win, a finished game.
-- `p_dry_run` is what makes that safe. It runs the real body and unwinds it
-- with the HS001 trick `admin_test_tile` uses (20260912230000), so the console
-- can say exactly what WILL happen -- shot withdrawn, ship refloated, ring
-- reveals taken back, game reopened -- from the code that then does it, rather
-- than from a second description that can drift out of step with it.
--
-- The storage object stays in the bucket, orphaned, exactly as 0029 leaves the
-- ones it cascades away. Harmless at event scale, and deleting storage objects
-- belongs to the storage API rather than to SQL.

-- ============================================================
-- 1. Is this hull sunk, by this team's shots?
-- ============================================================
-- `ship_status` answers this already, but it is a `security_invoker` view, so
-- inside a definer function it is evaluated with the CALLER's RLS rather than
-- the owner's. This asks the tables directly and is definer like everything
-- else here, so the answer cannot change with who is pressing the button.
--
-- Phrased as "no cell of this hull is missing a hit", which is `>=` on the
-- counts without the counting -- and 0026's warning about `=` letting a ship
-- un-sink itself cannot apply to a NOT EXISTS.

create or replace function ship_is_sunk(p_ship_id uuid, p_shooter uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select p_ship_id is not null and not exists (
    select 1
      from ship_cells sc
      join teams t on t.id = sc.team_id
      left join tiles ti
             on ti.game_id = t.game_id and ti.row = sc.row and ti.col = sc.col
      left join tile_claims tc
             on tc.tile_id = ti.id
            and tc.team_id = p_shooter
            and tc.status  = 'fired'
            and tc.result  = 'hit'
     where sc.ship_id = p_ship_id
       and tc.id is null
  );
$$;

comment on function ship_is_sunk(uuid, uuid) is
  'True when every cell of p_ship_id carries a fired hit from p_shooter. Internal.';

revoke execute on function ship_is_sunk(uuid, uuid) from public, anon, authenticated;

-- ============================================================
-- 2. The new event is team-private
-- ============================================================
-- Its payload names the tile and the drop that was picked, which is secret #2
-- (0035): a tile name across the line tells the other team what sits on that
-- square. Same treatment as `evidence_submitted`. The `events_read` policy
-- calls this helper by name, so replacing the function is the whole change --
-- the policy does not need recreating.
--
-- Body otherwise verbatim from 20260910064435, empty search_path and qualified
-- enum included.

create or replace function public.is_team_private_event(p_type public.event_type)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_type = any(array[
    'evidence_submitted',
    'evidence_revoked',
    'slot_freed',
    'pet_jar_submitted',
    'pet_jar_spent'
  ]::public.event_type[]);
$$;

revoke execute on function public.is_team_private_event(public.event_type)
  from public, anon;
grant execute on function public.is_team_private_event(public.event_type)
  to authenticated;

-- ============================================================
-- 3. The review list says what was picked
-- ============================================================
-- The screen exists to settle "they submitted the wrong thing", and until now
-- it showed the screenshot, the tile and the submitter but not the DROP the
-- submitter chose -- which is the thing that was wrong. A points tile's
-- screenshot of a fire cape looks identical whether it was filed as a fire
-- cape or as an infernal.
--
-- `points` is returned raw. On a `value` tile it is tenths of a million
-- (20260913040000), so `completion` comes with it and the client divides --
-- the same contract every other screen works to.
--
-- RETURNS TABLE cannot be changed by `create or replace`, so this drops and
-- recreates, and the grants go with it. Re-applied below; see 0014 for what
-- forgetting that costs.

drop function if exists admin_list_evidence(uuid);

create function admin_list_evidence(p_game_id uuid)
returns table (id uuid, claim_id uuid, storage_path text, uploaded_by_name text,
               created_at timestamptz, team_id uuid, team_name text,
               tile_position smallint, tile_name text, status claim_status,
               option_label text, points integer, completion text,
               required_evidence smallint, public_url text)
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  return query
    select e.id, e.claim_id, e.storage_path, e.uploaded_by_name, e.created_at,
           e.team_id, tm.name, t.position, t.name, c.status,
           -- Cast: the column is smallint, and a RETURNS TABLE that disagrees
           -- with its query fails at call time rather than at create time.
           o.label, e.points::int, t.completion::text, t.required_evidence,
           e.public_url
      from tile_evidence e
      join tile_claims c on c.id = e.claim_id
      join tiles t on t.id = c.tile_id
      join teams tm on tm.id = e.team_id
      left join tile_options o on o.id = e.option_id
     where t.game_id = p_game_id
     order by e.created_at desc;
end;
$$;

revoke execute on function admin_list_evidence(uuid) from public, anon;
grant  execute on function admin_list_evidence(uuid) to authenticated;

-- ============================================================
-- 4. Taking it back
-- ============================================================

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

  -- Locked for the rest of the transaction, exactly as `add_evidence` locks it:
  -- a member landing the last screenshot mid-revoke must queue behind this,
  -- not fire against a count that is about to change underneath them.
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

  -- Which hull this square belongs to, and whether it is down -- both read
  -- BEFORE anything moves, because after the revert neither is answerable.
  if v_was_fired and v_result = 'hit' then
    select sc.ship_id into v_ship_id
      from ship_cells sc
     where sc.team_id = v_enemy_id and sc.row = v_tile.row and sc.col = v_tile.col;

    if v_ship_id is not null then
      -- Aliased, and counted the way 0026 counts it: bare `(row, col)` reads
      -- as a ROW constructor, and `ships.size` is the denormalised column that
      -- migration stopped trusting.
      select count(distinct (sc.row, sc.col))::int into v_ship_size
        from ship_cells sc where sc.ship_id = v_ship_id;
      v_was_sunk := ship_is_sunk(v_ship_id, v_claim.team_id);
    end if;
  end if;

  -- Everything below is either committed or unwound as one. plpgsql variables
  -- are not transactional, so the summary built inside survives the rollback
  -- and is what a dry run returns -- the whole point of running the real body.
  begin
    delete from tile_evidence where id = p_evidence_id;

    select count(*), coalesce(sum(points), 0)
      into v_left, v_points
      from tile_evidence where claim_id = v_claim.id;

    -- The one authority on whether the tile is finished, asked again with the
    -- row gone. A tile that overshot its target is still finished without it.
    v_still := claim_is_complete(v_claim.id);

    if v_was_fired and not v_still then
      v_unfired := true;

      -- `fired_rows_complete` (0001) will not have a fired row without a
      -- result, nor an active row with one, so all four columns move together.
      update tile_claims
         set status = 'active', result = null, fired_by = null, fired_at = null
       where id = v_claim.id;

      if v_was_sunk and not ship_is_sunk(v_ship_id, v_claim.team_id) then
        v_refloated := true;

        -- The free reveals that sinking handed out. See note 1 at the top for
        -- why each condition is here.
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
             -- A square can ring two hulls. If the other one is still down,
             -- the reveal was earned twice and only one of them is being
             -- taken back.
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

      -- A win that rested on this shot. Guarded on the enemy actually having
      -- something afloat again, so a game won by the OTHER team, or won by a
      -- different hull entirely, is left alone.
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
     where team_id = v_claim.team_id and status = 'active';
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
      -- What the claim looks like afterwards.
      'evidence_left',     v_left,
      'points_left',       v_points,
      'still_complete',    v_still,
      'was_fired',         v_was_fired,
      'shot_result',       v_result,
      -- What gets undone.
      'unfired',           v_unfired,
      'ship_refloated',    v_refloated,
      'ship_size',         case when v_refloated then v_ship_size end,
      'reveals_withdrawn', v_rings,
      'game_reopened',     v_reopened,
      -- The slot warning: `active_tiles` is the count this leaves behind, and
      -- it is allowed to exceed `max_active_tiles`. See note 3 at the top.
      'active_tiles',      v_active,
      'max_active_tiles',  v_limit,
      'over_slot_limit',   v_active > coalesce(v_limit, v_active)
    );

    if p_dry_run then
      -- Unwinds every statement in this block. Same trick, and the same
      -- private SQLSTATE, as admin_test_tile (20260912230000).
      raise exception 'dry run complete' using errcode = 'HS001';
    end if;

    -- Team-private (section 2), so the tile name and the drop label are safe
    -- here and ONLY here. Never add either to a globally readable event type.
    --
    -- Appended, not substituted: the `shot_fired` and `ship_sunk` rows this
    -- undoes are left standing. The feed is a record of what happened, and
    -- what happened is that a shot was fired and then withdrawn. The board
    -- itself is derived from the claims, so it corrects on its own.
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
              'ship_refloated',    v_refloated,
              'reveals_withdrawn', v_rings,
              'game_reopened',     v_reopened,
              'by',                auth.uid(),
              'by_name',           coalesce(v_by, 'an admin')
            ));

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
-- 5. The broadcast line
-- ============================================================
-- Routed to the team's own channel by the same RLS split as
-- `evidence_submitted`, which is the only reason it may name the tile.
--
-- Body otherwise verbatim from 0045; only the new branch is added.

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
    -- Says what it cost, because the team has to know whether to resubmit, and
    -- whether a shot they had already celebrated is gone.
    when 'evidence_revoked' then format(
        ':leftwards_arrow_with_hook: An admin withdrew %s''s submission for **%s**%s — now %s/%s.%s',
        coalesce(p_event.payload ->> 'submitted_by_name', v_team),
        coalesce(p_event.payload ->> 'tile_name', 'a tile'),
        coalesce(' (' || (p_event.payload ->> 'option_label') || ')', ''),
        p_event.payload ->> 'evidence_count',
        p_event.payload ->> 'required_evidence',
        case when (p_event.payload ->> 'unfired')::boolean
             then ' The shot has been taken back and the tile is active again.'
             else '' end
        || case when (p_event.payload ->> 'ship_refloated')::boolean
                then ' A ship is no longer sunk.' else '' end
        || case when (p_event.payload ->> 'game_reopened')::boolean
                then ' **The game has been reopened.**' else '' end)
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
