-- An organiser can give a team its slot back.
--
-- Found by simulation, alongside the post-game shot 0027 fixes: a tile, once
-- locked in, could not be released by anybody. It leaves `active` only by
-- firing, and firing needs its full evidence count. So a team that locked in a
-- square it could not actually finish had lost one of its two slots for the
-- rest of the event — and two such squares and that team was simply out of the
-- game, with no move left to make.
--
-- The only ways back were `complete_tile_early` (flagged tiles only),
-- `admin_reset_game` (which destroys every locked-in tile, the feed and the
-- score), or hand-written SQL on the night.
--
-- **Admin only, deliberately.** Letting a captain drop their own square would
-- turn locking in into a way to *read* a tile and then back out of it: lock in,
-- see the name through `tiles_for_me`, release, repeat. That is secret #2 handed
-- over a square at a time, for free. An organiser releasing on request keeps the
-- cost — you have to ask, and somebody notices.
--
-- It DELETES the claim rather than marking it released, which is what restores
-- the pre-lock-in state exactly: the slot is free, `unique (team_id, tile_id)`
-- no longer blocks the square, and no phantom row is left for the scoreboard or
-- `tiles_for_me` to trip over. A third `claim_status` value would have meant
-- revisiting every `status = 'active'` filter in the schema — the active-limit
-- trigger, `team_scores`, `tiles_for_me`, `admin_tile_progress` — which is not a
-- change to make with an event approaching.
--
-- Two consequences, both accepted and both surfaced to the organiser before they
-- press it:
--
--   * `tile_evidence.claim_id` is ON DELETE CASCADE, so releasing takes that
--     tile's submitted screenshots with it. The RPC counts them first and
--     returns the number, and the console prints it in the confirmation, so
--     nobody destroys six uploads thinking they are freeing an empty slot.
--     Player-facing immutability is unchanged: `tile_evidence` still has no
--     delete policy, and this is a definer function gated on is_admin().
--   * The objects those rows pointed at stay in the `evidence` bucket, orphaned.
--     Harmless at event scale — a released tile holds at most a handful of
--     screenshots — and deleting storage objects properly belongs to the storage
--     API rather than to SQL.
--
-- A fired claim is refused outright: releasing one would silently undo a shot,
-- and with it a hit, a sinking, possibly a win.

create or replace function admin_release_claim(p_claim_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_claim    tile_claims%rowtype;
  v_tile     tiles%rowtype;
  v_status   game_status;
  v_evidence int;
begin
  if not is_admin() then raise exception 'Admins only'; end if;

  -- Locked so a member cannot land the last piece of evidence, and with it the
  -- shot, between the status check below and the delete.
  select * into v_claim from tile_claims where id = p_claim_id for update;
  if not found then raise exception 'No such tile claim'; end if;

  if v_claim.status = 'fired' then
    raise exception 'That tile has already been fired — releasing it would undo the shot';
  end if;

  select * into v_tile from tiles where id = v_claim.tile_id;

  select status into v_status from games where id = v_tile.game_id;
  if v_status <> 'active' then
    raise exception 'The game is % — there is nothing to release', v_status;
  end if;

  select count(*) into v_evidence from tile_evidence where claim_id = p_claim_id;

  -- Cascades to tile_evidence. See the note above.
  delete from tile_claims where id = p_claim_id;

  -- No tile_name: the feed is world-readable, and naming the square would tell
  -- the other team what sits on it. Position only, exactly as `tile_claimed`.
  insert into game_events (game_id, team_id, type, payload)
  values (v_tile.game_id, v_claim.team_id, 'claim_released',
          jsonb_build_object('tile_id', v_tile.id,
                             'position', v_tile.position,
                             'evidence_deleted', v_evidence,
                             'by', auth.uid()));

  return jsonb_build_object(
    'released',         true,
    'position',         v_tile.position,
    'evidence_deleted', v_evidence
  );
end;
$$;

revoke execute on function admin_release_claim(uuid) from public, anon;
grant  execute on function admin_release_claim(uuid) to authenticated;
