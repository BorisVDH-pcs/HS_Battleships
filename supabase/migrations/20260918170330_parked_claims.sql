-- A revoked tile is unlocked, not handed back.
--
-- `admin_revoke_evidence` (20260918163924) un-fired a claim by setting it
-- straight back to `active`. That restores the tile, and breaks the rule the
-- whole slot system exists for: the active-tile limit is a **BEFORE INSERT**
-- trigger, so an UPDATE walks past it untouched. A team whose completed tile
-- was revoked ended up working four tiles, five if two were revoked — and the
-- slot they gained was real, because firing had already freed one and they had
-- spent it on something else.
--
-- So the un-fired claim is now PARKED: the row and every screenshot on it
-- survive, the tile stays revealed and its progress intact, but it occupies no
-- slot and takes no more evidence until the team locks it in again. Nine of ten
-- stays nine of ten; finishing it costs a slot, exactly as it did the first
-- time.
--
-- ---- why a column and not a third claim_status ----
--
-- 0029 considered a third status and refused it, correctly: `status = 'active'`
-- is read in a dozen places and a new enum value silently changes the meaning
-- of every one. A nullable timestamp is additive instead — every existing row
-- is `null`, which means "not parked", so nothing that does not ask about it
-- changes behaviour. `fired_rows_complete` already permits the shape a parked
-- row has (active, no result, no fired_at), so that constraint is untouched.
--
-- The audit that made this safe to do at all: of 23 functions that touch
-- `tile_claims`, only THREE read the claim's own `'active'` status --
-- `enforce_active_limit`, `team_scores`, and a dead payload field in
-- `add_evidence`. The other seven matches are reading `games.status`, which is
-- a different table. Everything about hits, sinking and the board filters on
-- `'fired'`, and a parked claim is not fired, so none of it moves. Completion
-- (`claim_is_complete`, `evidence_refusal`) reads evidence rows and never looks
-- at the claim at all.
--
-- ---- the two things that actually needed care ----
--
--   1. The limit trigger had to grow an UPDATE arm. Without it, re-locking a
--      parked tile is an UPDATE, and a team already holding three could take a
--      fourth — the same hole, moved.
--   2. `unique (team_id, tile_id)` means re-claiming cannot INSERT. `claim_tile`
--      now finds the parked row and un-parks it; without that, locking in again
--      fails on the constraint instead of working.
--
-- `add_evidence` is deliberately NOT modified. The refusal belongs on the table
-- rather than inside one RPC — 0021's argument for `claims_need_evidence`, and
-- it holds here for the same reason. Its one stale count, `tiles_left_to_fire`,
-- is a payload field 0045 stopped printing and nothing reads today.

-- ============================================================
-- 1. The flag
-- ============================================================
-- Null means "not parked", so every row that exists today is already correct.

alter table tile_claims add column if not exists paused_at timestamptz;

-- A fired claim cannot be parked: parking is what un-firing produces, and the
-- two together would be a row that is both finished and not started.
alter table tile_claims
  drop constraint if exists tile_claims_paused_only_when_active,
  add  constraint tile_claims_paused_only_when_active
       check (paused_at is null or status = 'active');

comment on column tile_claims.paused_at is
  'Set when an organiser revoked a completing submission. The claim keeps its '
  'evidence and the tile stays revealed, but it holds no slot and takes no more '
  'evidence until the team locks it in again.';

create index if not exists tile_claims_active_unparked_idx
  on tile_claims (team_id) where status = 'active' and paused_at is null;

-- ============================================================
-- 2. The limit counts slots, not claims
-- ============================================================
-- Body is 0001's, with `paused_at is null` added to the count. It now serves
-- two triggers, so the message says "holding" rather than naming an insert.

create or replace function enforce_active_limit() returns trigger
language plpgsql set search_path = public as $$
declare
  limit_n  smallint;
  active_n smallint;
begin
  select g.max_active_tiles into limit_n
    from games g join teams t on t.game_id = g.id
   where t.id = new.team_id;

  select count(*) into active_n
    from tile_claims
   where team_id = new.team_id
     and status = 'active'
     and paused_at is null
     and id <> new.id;

  if active_n >= limit_n then
    raise exception 'Team % is already holding % active tiles — finish or free one first',
      new.team_id, limit_n;
  end if;
  return new;
end;
$$;

-- The INSERT arm, restated so a database built from these files in order ends
-- up identical to this one. Unchanged but for the count above.
drop trigger if exists tile_claims_active_limit on tile_claims;
create trigger tile_claims_active_limit
  before insert on tile_claims
  for each row when (new.status = 'active' and new.paused_at is null)
  execute function enforce_active_limit();

-- The UPDATE arm: the new one, and the reason this migration exists.
--
-- Fires only on a transition INTO occupying a slot — a parked claim being
-- locked in again, or (should anything ever do it) a fired claim going active
-- unparked. It deliberately does NOT fire when `admin_revoke_evidence` parks a
-- claim, because a parked row holds no slot and must never be refused for a
-- limit it is not consuming.
drop trigger if exists tile_claims_active_limit_update on tile_claims;
create trigger tile_claims_active_limit_update
  before update on tile_claims
  for each row when (
    new.status = 'active' and new.paused_at is null
    and (old.status <> 'active' or old.paused_at is not null)
  )
  execute function enforce_active_limit();

-- ============================================================
-- 3. Locking it in again
-- ============================================================
-- `unique (team_id, tile_id)` means the second lock-in is an UPDATE, not an
-- INSERT. Everything else is 0002's body verbatim, including the event: the
-- feed should say the tile was claimed, because from the team's side that is
-- exactly what happened.
--
-- `claimed_by` and `claimed_at` are reset to whoever is picking it back up.
-- The slot cards answer "who is on this, and since when" (20260907173724), and
-- the honest answer after a re-lock is the person who just took it, not the
-- one who locked it in yesterday.

create or replace function claim_tile(p_tile_id uuid)
returns tile_claims
language plpgsql security definer set search_path = public as $$
declare
  v_team_id uuid;
  v_tile    tiles%rowtype;
  v_claim   tile_claims;
  v_existing tile_claims%rowtype;
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

  -- Locked, so two members pressing at once cannot both un-park it and slip
  -- two claims past a limit that had room for one.
  select * into v_existing from tile_claims
   where team_id = v_team_id and tile_id = p_tile_id for update;

  if found then
    if v_existing.status = 'fired' then
      raise exception 'Your team has already fired at that square';
    elsif v_existing.paused_at is null then
      raise exception 'Your team already has that tile locked in';
    end if;

    -- Parked: pick it up where it was left. The limit is enforced by the
    -- UPDATE trigger above, so a team with no free slot is refused here.
    update tile_claims
       set paused_at = null, claimed_by = auth.uid(), claimed_at = now()
     where id = v_existing.id
    returning * into v_claim;
  else
    insert into tile_claims (team_id, tile_id, claimed_by)
    values (v_team_id, p_tile_id, auth.uid())
    returning * into v_claim;
  end if;

  insert into game_events (game_id, team_id, type, payload)
  values (v_tile.game_id, v_team_id, 'tile_claimed',
          jsonb_build_object('tile_id', v_tile.id,
                             'position', v_tile.position, 'by', auth.uid()));

  return v_claim;
end;
$$;

revoke execute on function claim_tile(uuid) from public, anon;
grant  execute on function claim_tile(uuid) to authenticated;

-- ============================================================
-- 4. A parked tile takes no evidence
-- ============================================================
-- On the table rather than inside `add_evidence`, following
-- `claims_need_evidence` (0021): a rule that lives on the table cannot be
-- stepped around by an RPC, a service-role call, or a hand-written INSERT.
-- It also means `add_evidence` — 150 lines of completion rules — is not
-- touched by this migration at all.

create or replace function refuse_evidence_while_parked() returns trigger
language plpgsql set search_path = public as $$
begin
  if exists (select 1 from tile_claims c
              where c.id = new.claim_id and c.paused_at is not null) then
    raise exception 'That tile is not locked in — lock it in again before submitting';
  end if;
  return new;
end;
$$;

drop trigger if exists evidence_not_while_parked on tile_evidence;
create trigger evidence_not_while_parked
  before insert on tile_evidence
  for each row execute function refuse_evidence_while_parked();

-- ============================================================
-- 5. A parked tile is not an active tile
-- ============================================================
-- Body is 0020's, with `paused_at is null` on the active count alone. The hit,
-- miss, fired and sunk counts are untouched: they filter on `'fired'`, which a
-- parked claim is not.

create or replace function team_scores(p_game_id uuid)
returns table (game_id uuid, team_id uuid, team_name text, tiles_fired integer,
               hits integer, misses integer, active_tiles integer,
               ships_sunk integer, adjustments integer, total integer)
language sql stable security definer set search_path = public as $$
  with base as (
    select
      t.game_id as g_id,
      t.id      as t_id,
      t.name    as t_name,
      (select count(*) from tile_claims c
        where c.team_id = t.id and c.status = 'fired')::int as n_fired,
      (select count(*) from tile_claims c
        where c.team_id = t.id and c.status = 'fired' and c.result = 'hit')::int as n_hits,
      (select count(*) from tile_claims c
        where c.team_id = t.id and c.status = 'fired' and c.result = 'miss')::int as n_misses,
      (select count(*) from tile_claims c
        where c.team_id = t.id and c.status = 'active' and c.paused_at is null)::int as n_active,
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
          ))::int as n_sunk
    from teams t
    where t.game_id = p_game_id
  )
  select
    b.g_id, b.t_id, b.t_name,
    b.n_fired, b.n_hits, b.n_misses, b.n_active, b.n_sunk,
    0::integer as adjustments,
    b.n_hits as total
  from base b
  order by b.t_name;
$$;

revoke execute on function team_scores(uuid) from public, anon;
grant  execute on function team_scores(uuid) to authenticated;

-- ============================================================
-- 6. The board has to be able to draw it
-- ============================================================
-- One new column, `paused`. The tile stays `revealed` and keeps its name, icon,
-- progress and drop list — the team has seen all of it and parking is not a
-- punishment — but the client needs to know the square is lockable again and
-- that it is not holding one of their slots.
--
-- RETURNS TABLE cannot be changed by `create or replace`, so this drops and
-- recreates, and the grants go with it. Re-applied below; see 0014.
-- `board_for_me` wraps this in `to_jsonb(x)`, so the new column reaches the
-- client with no change there.
--
-- Body is otherwise the deployed definition, character for character.

drop function if exists tiles_for_me(uuid);

create function tiles_for_me(p_game_id uuid)
returns table (
  id uuid, game_id uuid, "row" smallint, col smallint, "position" smallint,
  revealed boolean, name text, icon text,
  required_evidence smallint, evidence_count integer,
  claim_id uuid, claim_status claim_status, claim_result shot_result,
  previewed boolean, ship_sunk boolean,
  evidence_points integer, options jsonb, description text,
  completion text, per_set smallint,
  claimed_by_name text, claimed_at timestamptz,
  paused boolean
)
language sql stable security definer set search_path = public as $$
  select t.id, t.game_id, t.row, t.col, t.position,
    (c.id is not null) as revealed,
    case when c.id is not null or pv.id is not null then t.name end as name,
    case when c.id is not null or pv.id is not null then t.icon end as icon,
    case when c.id is not null then t.required_evidence end as required_evidence,
    case when c.id is not null
         then (select count(*) from tile_evidence e where e.claim_id = c.id)
         else 0 end::int as evidence_count,
    c.id, c.status, c.result,
    (pv.id is not null) as previewed,
    coalesce(
      c.result = 'hit' and not exists (
        select 1
          from ship_cells hull
         where hull.ship_id = (
                 select sc.ship_id
                   from ship_cells sc
                   join teams te on te.id = sc.team_id
                  where te.game_id = t.game_id
                    and te.id <> c.team_id
                    and sc.row = t.row and sc.col = t.col
                  limit 1
               )
           and not exists (
                 select 1
                   from tiles ti2
                   join tile_claims tc2 on tc2.tile_id = ti2.id
                  where ti2.game_id = t.game_id
                    and ti2.row = hull.row and ti2.col = hull.col
                    and tc2.team_id = c.team_id
                    and tc2.status = 'fired'
                    and tc2.result = 'hit'
               )
      ),
      false
    ) as ship_sunk,
    case when c.id is not null
         then (select coalesce(sum(e.points), 0) from tile_evidence e where e.claim_id = c.id)
         else 0 end::int as evidence_points,
    case when c.id is not null
         then (select coalesce(jsonb_agg(jsonb_build_object(
                        'id', o.id, 'label', o.label, 'points', o.points,
                        'grp', o.grp, 'max_times', o.max_times,
                        'taken', exists (select 1 from tile_evidence e
                                          where e.claim_id = c.id and e.option_id = o.id),
                        'got', (select count(*) from tile_evidence e
                                 where e.claim_id = c.id and e.option_id = o.id)
                      ) order by o.sort, o.label), '[]'::jsonb)
                 from tile_options o where o.tile_id = t.id)
         end as options,
    case when c.id is not null then t.description end as description,
    case when c.id is not null then t.completion::text end as completion,
    case when c.id is not null then t.per_set end as per_set,
    p.display_name as claimed_by_name,
    c.claimed_at,
    (c.paused_at is not null) as paused
  from tiles t
  left join tile_claims c on c.tile_id = t.id
       and c.team_id = my_team_in_game(p_game_id)
  left join profiles p on p.id = c.claimed_by
  left join pet_jar_previews pv on pv.tile_id = t.id
       and pv.team_id = my_team_in_game(p_game_id)
  where t.game_id = p_game_id
  order by t.position;
$$;

revoke execute on function tiles_for_me(uuid) from public, anon;
grant  execute on function tiles_for_me(uuid) to authenticated;

-- ============================================================
-- 7. Revoking parks instead of handing back
-- ============================================================
-- The only change to 20260918163924's body: the un-fire UPDATE also sets
-- `paused_at`, and the summary reports `parked` where it used to report an
-- over-limit warning that can no longer happen.

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

      -- Parked, not handed back. `paused_at` is what keeps the slot rule
      -- true through a revoke -- see the header.
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

    -- Slots in use afterwards. A parked claim is excluded, so this can no
    -- longer exceed the limit -- which is the whole point of the migration.
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
      -- Parked whenever the shot came back: the team must lock it in again.
      'parked',            v_unfired,
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
-- 8. The broadcast line says what to do next
-- ============================================================
-- Only the `evidence_revoked` branch changes: "active again" was the old
-- behaviour and would now be a lie. Body otherwise verbatim from
-- 20260918163924.

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
