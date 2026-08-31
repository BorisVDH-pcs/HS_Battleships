-- The last piece of evidence and the shot are one transaction.
--
-- Until now the client did it in two calls: add_evidence(), then fire_tile().
-- Between them sat a network, so a tile could end up holding all its evidence
-- and still be active — a slot occupied by a task nobody could see was finished,
-- freed only if someone found the recovery button. Rare, but the state should
-- not exist at all: a tile is either being worked or it has been fired.
--
-- Firing here rather than in the client also means the rule cannot be skipped
-- by a hand-written call. add_evidence is the only way a row reaches
-- tile_evidence (the table has a select policy and nothing else), so the shot
-- now goes off wherever the evidence completes.
--
-- `for update` on the claim serialises two members submitting the last piece at
-- the same moment: the second waits, sees status = 'fired', and is told the tile
-- is already done rather than firing it twice.

drop function if exists add_evidence(uuid, text);

create function add_evidence(p_claim_id uuid, p_storage_path text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_claim    tile_claims%rowtype;
  v_tile     tiles%rowtype;
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

  -- The requirement met is the shot. fire_tile() re-checks membership and the
  -- unfired status itself, and the claims_need_evidence trigger checks the
  -- count once more on the way through — all three now pass by construction,
  -- which is the point.
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
