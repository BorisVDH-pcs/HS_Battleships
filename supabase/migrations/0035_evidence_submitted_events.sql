-- Evidence submissions join the event feed — for the submitting team only.
--
-- Every other event type carries no tile identity, which is what lets
-- `events_read using (true)` be blanket-open (see 0001, secret #2): the feed
-- is shared, and the payload has nothing to leak. `evidence_submitted` breaks
-- that pattern on purpose — the message wants a tile name, and a tile name is
-- exactly what the other team must never see. So it does not get a blanket
-- policy: it gets its own, scoped to the team the event belongs to (or an
-- admin). `slot_freed` carries no tile identity and could stay open, but it
-- is only ever meaningful to the team whose slot just freed, so it is scoped
-- the same way for a quieter feed rather than for secrecy.
--
-- This is the same protection the Discord relay (0036) needs, and for the
-- same reason: `game_events` is read directly by the app's own EventFeed,
-- not just relayed outward, so the RLS policy is the actual guard — routing
-- the Discord message to a team-only channel is not enough on its own.

drop policy if exists events_read on game_events;

create policy events_read on game_events for select using (
  type not in ('evidence_submitted', 'slot_freed')
  or team_id in (select my_team_ids())
  or is_admin()
);

-- ============================================================

drop function if exists add_evidence(uuid, text);

create function add_evidence(p_claim_id uuid, p_storage_path text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_claim     tile_claims%rowtype;
  v_tile      tiles%rowtype;
  v_name      text;
  v_prefix    text;
  v_row       tile_evidence;
  v_have      int;
  v_required  smallint;
  v_result    shot_result;
  v_will_fire boolean;
  v_left      int;
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
  v_will_fire := v_have >= v_required;

  -- "Tiles left to fire" mirrors ActiveTiles.jsx's "(n/maxActive)" header —
  -- the team's active slots, minus this one once it fires.
  select count(*) into v_left from tile_claims
   where team_id = v_claim.team_id and status = 'active';
  if v_will_fire then v_left := v_left - 1; end if;

  insert into game_events (game_id, team_id, type, payload)
  values (v_tile.game_id, v_claim.team_id, 'evidence_submitted',
          jsonb_build_object(
            'claim_id', p_claim_id,
            'position', v_tile.position,
            'tile_name', v_tile.name,
            'uploaded_by_name', coalesce(v_name, 'unknown'),
            'evidence_count', v_have,
            'required_evidence', v_required,
            'tiles_left_to_fire', v_left
          ));

  -- The requirement met is the shot. fire_tile() re-checks membership and the
  -- unfired status itself, and the claims_need_evidence trigger checks the
  -- count once more on the way through — all three now pass by construction,
  -- which is the point.
  if v_will_fire then
    v_result := fire_tile(p_claim_id);

    insert into game_events (game_id, team_id, type, payload)
    values (v_tile.game_id, v_claim.team_id, 'slot_freed',
            jsonb_build_object('claim_id', p_claim_id, 'position', v_tile.position));
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
