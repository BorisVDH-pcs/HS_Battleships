-- A shot may only be fired while the game is active.
--
-- Found by playing a full game against this database: the losing team can take
-- the win after the game is already over.
--
-- `claim_tile` checks that the game is `active`. `fire_tile` never did. It
-- validates the claim, the already-fired flag and membership, and nothing else.
-- So a claim that was already open when the game ended stays fireable for ever,
-- and every route into it still works: `add_evidence` (which fires in the same
-- transaction once the requirement is met, 0023), `complete_tile_early`, and the
-- rescue Fire button. The winner update then runs unconditionally:
--
--     update games set status = 'finished', winner_team_id = v_claim.team_id ...
--
-- so the second sinking simply overwrites the first winner.
--
-- Reproduced end to end: Bravo was left one cell short, holding an open claim.
-- Alpha completed its hunt and won. Bravo then submitted the evidence it had
-- already been working on, and:
--
--     before:  status=finished  winner=Sim Alpha
--     after:   status=finished  winner=Sim Bravo
--
-- with two `game_won` events in the feed and a 17-17 scoreboard.
--
-- This is not a corner case. Each team may hold two open claims, so both sides
-- are almost always carrying live claims at the moment somebody wins, and the
-- player page rendered the slots and their upload controls in every status. A
-- team finishing an upload ten seconds after losing rewrote the result.
--
-- The guard goes in `fire_tile`, which is the single point all three routes
-- funnel through. `add_evidence` and `complete_tile_early` get the same check up
-- front as well, so a player who is too late is told so before uploading rather
-- than after — and the winner update is narrowed to a game that is still active,
-- which makes the overwrite impossible even if some future caller reaches
-- `fire_tile` another way.
--
-- Bodies are otherwise character-for-character the current ones: `fire_tile` and
-- `assert_fleets_consistent` from 0026, `add_evidence` from 0023,
-- `complete_tile_early` from 0025. Return types are unchanged, so
-- `create or replace` keeps the existing grants; the revoke/grant pairs are
-- repeated anyway, as the rest of this directory does.

create or replace function fire_tile(p_claim_id uuid)
returns shot_result
language plpgsql security definer set search_path = public as $$
declare
  v_claim    tile_claims%rowtype;
  v_tile     tiles%rowtype;
  v_game_id  uuid;
  v_status   game_status;
  v_enemy_id uuid;
  v_result   shot_result;
  v_ship_id  uuid;
  v_ship     record;
begin
  select * into v_claim from tile_claims where id = p_claim_id;

  if v_claim is null then
    raise exception 'No such tile claim';
  end if;
  if v_claim.status = 'fired' then
    raise exception 'That tile has already been fired';
  end if;
  if not exists (select 1 from team_members
                  where team_id = v_claim.team_id and profile_id = auth.uid()) then
    raise exception 'That tile belongs to the other team';
  end if;

  select * into v_tile from tiles where id = v_claim.tile_id;
  v_game_id := v_tile.game_id;

  -- The game has to still be running. Without this a claim left open when the
  -- match ended can be fired afterwards, and the winner update below rewrites
  -- who won.
  select status into v_status from games where id = v_game_id;
  if v_status <> 'active' then
    raise exception 'The game is % — no more shots', v_status;
  end if;

  select id into v_enemy_id from teams
   where game_id = v_game_id and id <> v_claim.team_id;

  select sc.ship_id into v_ship_id
    from ship_cells sc
   where sc.team_id = v_enemy_id and sc.row = v_tile.row and sc.col = v_tile.col;

  v_result := case when v_ship_id is null then 'miss' else 'hit' end;

  update tile_claims
     set status = 'fired', result = v_result, fired_by = auth.uid(), fired_at = now()
   where id = p_claim_id;

  insert into game_events (game_id, team_id, type, payload)
  values (v_game_id, v_claim.team_id, 'shot_fired',
          jsonb_build_object('tile_id', v_tile.id,
                             'position', v_tile.position, 'result', v_result,
                             'by', auth.uid()));

  if v_result = 'hit' then
    -- Read once: the size announced and the sunk decision must come from the
    -- same row, or a wrong `ships.size` creeps back in through the payload.
    select * into v_ship from ship_status where ship_id = v_ship_id;

    if v_ship.sunk then
      insert into game_events (game_id, team_id, type, payload)
      values (v_game_id, v_claim.team_id, 'ship_sunk',
              jsonb_build_object('ship_id', v_ship_id,
                                 'size', v_ship.size,
                                 'victim_team_id', v_enemy_id));

      if not exists (select 1 from ship_status where team_id = v_enemy_id and not sunk) then
        -- `and status = 'active'` so a win can never overwrite a win.
        update games set status = 'finished', winner_team_id = v_claim.team_id, ended_at = now()
         where id = v_game_id and status = 'active';

        if found then
          insert into game_events (game_id, team_id, type, payload)
          values (v_game_id, v_claim.team_id, 'game_won',
                  jsonb_build_object('loser_team_id', v_enemy_id));
        end if;
      end if;
    end if;
  end if;

  return v_result;
end;
$$;

revoke execute on function fire_tile(uuid) from public, anon;
grant  execute on function fire_tile(uuid) to authenticated;


-- Same check, up front, so a team that is too late is told before it uploads.
create or replace function add_evidence(p_claim_id uuid, p_storage_path text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_claim    tile_claims%rowtype;
  v_tile     tiles%rowtype;
  v_status   game_status;
  v_name     text;
  v_prefix   text;
  v_row      tile_evidence;
  v_have     int;
  v_required smallint;
  v_result   shot_result;
begin
  -- Locked for the rest of the transaction: the count read below decides
  -- whether to fire, and two concurrent submits must not both read "one short".
  select * into v_claim from tile_claims where id = p_claim_id for update;
  if not found then raise exception 'No such tile claim'; end if;

  if not exists (select 1 from team_members
                  where team_id = v_claim.team_id and profile_id = auth.uid()) then
    raise exception 'That tile belongs to the other team';
  end if;

  if v_claim.status = 'fired' then
    raise exception 'That tile has already been fired';
  end if;

  select * into v_tile from tiles where id = v_claim.tile_id;

  select status into v_status from games where id = v_tile.game_id;
  if v_status <> 'active' then
    raise exception 'The game is % — this tile can no longer be completed', v_status;
  end if;

  -- Must match the claim being registered. Without this a player could upload
  -- into a valid folder of their own and then attach it to any claim at all.
  v_prefix := v_tile.game_id || '/' || v_claim.team_id || '/' || v_claim.id || '/';
  if position(v_prefix in p_storage_path) <> 1 then
    raise exception 'That evidence path does not belong to this claim';
  end if;

  select display_name into v_name from profiles where id = auth.uid();

  insert into tile_evidence (claim_id, team_id, storage_path, uploaded_by, uploaded_by_name)
  values (p_claim_id, v_claim.team_id, p_storage_path, auth.uid(),
          coalesce(v_name, 'unknown'))
  returning * into v_row;

  select count(*) into v_have from tile_evidence where claim_id = p_claim_id;
  v_required := coalesce(v_tile.required_evidence, 1);

  -- The requirement met is the shot. fire_tile() re-checks membership, the
  -- unfired status and the game status itself, and the claims_need_evidence
  -- trigger checks the count once more on the way through — all of which now
  -- pass by construction, which is the point.
  if v_have >= v_required then
    v_result := fire_tile(p_claim_id);
  end if;

  return jsonb_build_object(
    'evidence_id',       v_row.id,
    'evidence_count',    v_have,
    'required_evidence', v_required,
    'fired',             v_result is not null,
    'result',            v_result
  );
end;
$$;

revoke execute on function add_evidence(uuid, text) from public, anon;
grant  execute on function add_evidence(uuid, text) to authenticated;


-- And the short route, for the same reason.
create or replace function complete_tile_early(p_claim_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_claim  tile_claims%rowtype;
  v_tile   tiles%rowtype;
  v_status game_status;
  v_have   int;
  v_result shot_result;
begin
  -- Locked for the same reason add_evidence locks: two members pressing this at
  -- once must not both fire.
  select * into v_claim from tile_claims where id = p_claim_id for update;
  if not found then raise exception 'No such tile claim'; end if;

  if not exists (select 1 from team_members
                  where team_id = v_claim.team_id and profile_id = auth.uid()) then
    raise exception 'That tile belongs to the other team';
  end if;

  if v_claim.status = 'fired' then
    raise exception 'That tile has already been fired';
  end if;

  select * into v_tile from tiles where id = v_claim.tile_id;

  select status into v_status from games where id = v_tile.game_id;
  if v_status <> 'active' then
    raise exception 'The game is % — this tile can no longer be completed', v_status;
  end if;

  if not v_tile.early_complete then
    raise exception 'This tile has only one route to done — submit the evidence it asks for';
  end if;

  select count(*) into v_have from tile_evidence where claim_id = p_claim_id;
  if v_have < 1 then
    raise exception 'Submit at least one screenshot before completing this tile';
  end if;

  -- Set first, so the trigger on the status change below sees the declaration.
  update tile_claims set completed_early = true where id = p_claim_id;

  v_result := fire_tile(p_claim_id);

  return jsonb_build_object(
    'fired',          true,
    'result',         v_result,
    'evidence_count', v_have,
    'declared_early', true
  );
end;
$$;

revoke execute on function complete_tile_early(uuid) from public, anon;
grant  execute on function complete_tile_early(uuid) to authenticated;
