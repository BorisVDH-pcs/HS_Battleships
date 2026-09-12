-- Trying a tile out without playing it.
--
-- A board is built square by square against rules that only say what they mean
-- once evidence starts arriving, and the only way to find out whether a tile
-- finishes when it should was to put it in front of a team and watch. By then
-- the board is locked. `points_per_set` and the repeat caps both shipped having
-- been proved only in a hand-written transaction that nobody but their author
-- ever ran.
--
-- So: a dry run. The builder hands over a list of drops, this plays them into a
-- throwaway claim, asks `claim_is_complete()` after each one, and rolls the lot
-- back. Nothing is committed -- no claim, no evidence, no event, no shot -- so
-- nothing reaches the other team, the feed, or Discord.
--
-- WHY NOT ANSWER THIS IN THE BROWSER. `tileProgress.js` already predicts the
-- same answer, and asking it would need no server at all. But it is a MIRROR of
-- `claim_is_complete()`, kept in step by hand, and a tester that asks the mirror
-- whether the mirror is right proves nothing. The whole value is in asking the
-- authority. The builder shows both answers side by side, and says so loudly
-- when they disagree -- which is the drift this repo has been one careless edit
-- away from since 0049.

-- ============================================================
-- 1. Why a screenshot would be turned away
-- ============================================================
-- Extracted from `add_evidence` rather than copied out of it. These guards are
-- the difference between "the tile is not finished" and "that submission would
-- not have counted at all", and a tester that did not know them would cheerfully
-- report a tile finished by five fire capes when the fifth would be refused.
--
-- `each_set`'s group quota is in here too, which `add_evidence` never checked
-- itself -- it let the table trigger raise. Same message either way, raised a
-- little earlier now; the trigger stays as the thing that actually enforces it,
-- for the reason 0021 gives about rules that live on the table.

create or replace function evidence_refusal(p_claim_id uuid, p_option_id uuid)
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  v_tile  tiles%rowtype;
  v_opt   tile_options%rowtype;
  v_used  int;
  v_group text;
  v_have  int;
begin
  select t.* into v_tile
    from tiles t
    join tile_claims c on c.tile_id = t.id
   where c.id = p_claim_id;
  if not found then return 'No such tile claim'; end if;

  select * into v_opt from tile_options
   where id = p_option_id and tile_id = v_tile.id;
  if not found then return 'That is not one of this tile''s options'; end if;

  -- On a set tile a repeat is worth nothing, so it is refused rather than
  -- silently banked: a team that submits the same piece twice believing it
  -- counted would find out only when the tile failed to fire.
  if v_tile.completion in ('one_set', 'each_set') and exists (
       select 1 from tile_evidence
        where claim_id = p_claim_id and option_id = p_option_id
     ) then
    return format('You have already submitted %s for this tile', v_opt.label);
  end if;

  -- A capped drop stops counting once it has been counted its number of times.
  if v_opt.max_times is not null then
    select count(*) into v_used from tile_evidence
     where claim_id = p_claim_id and option_id = p_option_id;
    if v_used >= v_opt.max_times then
      return format('%s counts %s time(s) on this tile, and you have them all',
                    v_opt.label, v_opt.max_times);
    end if;
  end if;

  -- And an each_set group that already has its quota of DIFFERENT drops takes
  -- no more. Wording matched to the trigger's, since either may be what a
  -- player actually sees.
  if v_tile.completion = 'each_set' then
    v_group := coalesce(v_opt.grp, v_opt.label);
    select count(distinct e.option_id) into v_have
      from tile_evidence e
      join tile_options o on o.id = e.option_id
     where e.claim_id = p_claim_id
       and coalesce(o.grp, o.label) = v_group;
    if v_have >= v_tile.per_set then
      return 'You already have enough different drops from this group';
    end if;
  end if;

  return null;
end;
$$;

revoke execute on function evidence_refusal(uuid, uuid) from public, anon, authenticated;

-- ============================================================
-- 2. add_evidence asks it rather than repeating it
-- ============================================================
-- The two inline guards are gone; everything else is as it was. One behaviour
-- change worth naming: the old repeat message had a stray double space in it
-- ('submitted %  for'), which is now single.

create or replace function add_evidence(
  p_claim_id     uuid,
  p_storage_path text,
  p_public_url   text default null,
  p_option_id    uuid default null,
  p_amount       int  default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_claim     tile_claims%rowtype;
  v_tile      tiles%rowtype;
  v_name      text;
  v_prefix    text;
  v_row       tile_evidence;
  v_have      int;
  v_points    int;
  v_required  int;
  v_result    shot_result;
  v_will_fire boolean;
  v_left      int;
  v_has_opts  boolean;
  v_opt       tile_options%rowtype;
  v_opt_label text;
  v_award     int := 1;
  v_sets      boolean;
  v_refuse    text;
begin
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

  v_prefix := v_tile.game_id || '/' || v_claim.team_id || '/' || v_claim.id || '/';
  if position(v_prefix in p_storage_path) <> 1 then
    raise exception 'That evidence path does not belong to this claim';
  end if;

  select exists (select 1 from tile_options where tile_id = v_tile.id) into v_has_opts;
  v_sets := v_tile.completion in ('one_set', 'each_set');

  if v_tile.completion = 'value' then
    if p_option_id is not null then
      raise exception 'This tile is scored on the value you enter, not on a drop list';
    end if;
    if p_amount is null then
      raise exception 'Say what this drop was worth';
    end if;
    if p_amount < 1 or p_amount > 1000 then
      raise exception 'That value must be between 1 and 1000';
    end if;
    v_award := p_amount;

  else
    if p_amount is not null then
      raise exception 'This tile is not scored on a typed value';
    end if;

    if p_option_id is not null then
      if not v_has_opts then
        raise exception 'This tile has no drop options to choose from';
      end if;
      select * into v_opt from tile_options
       where id = p_option_id and tile_id = v_tile.id;
      if not found then raise exception 'That is not one of this tile''s options'; end if;

      v_refuse := evidence_refusal(p_claim_id, p_option_id);
      if v_refuse is not null then raise exception '%', v_refuse; end if;

      v_award     := case when v_sets then 1 else v_opt.points end;
      v_opt_label := v_opt.label;
    elsif v_has_opts then
      raise exception 'Say which drop this screenshot shows';
    end if;
  end if;

  select display_name into v_name from profiles where id = auth.uid();

  insert into tile_evidence (claim_id, team_id, storage_path, uploaded_by,
                             uploaded_by_name, public_url, option_id, points)
  values (p_claim_id, v_claim.team_id, p_storage_path, auth.uid(),
          coalesce(v_name, 'unknown'), nullif(btrim(coalesce(p_public_url, '')), ''),
          p_option_id, v_award)
  returning * into v_row;

  select count(*), coalesce(sum(points), 0)
    into v_have, v_points
    from tile_evidence where claim_id = p_claim_id;

  v_required  := coalesce(v_tile.required_evidence, 1);
  v_will_fire := claim_is_complete(p_claim_id);

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
            'tiles_left_to_fire', v_left,
            'image_url', v_row.public_url,
            -- Team-private event (0035), so the option label is safe here and
            -- ONLY here. Never add it to a globally readable event type.
            'option_label', v_opt_label,
            'points_awarded', v_award,
            'points_total', v_points,
            'completion', v_tile.completion::text,
            'weighted', v_has_opts
          ));

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
    'points_awarded',    v_award,
    'points_total',      v_points,
    'fired',             v_result is not null,
    'result',            v_result
  );
end;
$$;

revoke execute on function add_evidence(uuid, text, text, uuid, int) from public, anon;
grant  execute on function add_evidence(uuid, text, text, uuid, int) to authenticated;

-- ============================================================
-- 3. The dry run
-- ============================================================
-- `p_picks` is one entry per screenshot, in the order they would be submitted:
-- `{"option_id": "..."}` on a tile with drops, `{"amount": 40}` on a value tile,
-- `{}` on a plain count of screenshots. Order matters -- which submission tips
-- the tile over is most of what this is for.
--
-- HOW THE ROLLBACK WORKS. The play-through sits in a block with an EXCEPTION
-- clause, which Postgres runs as a subtransaction; the block ends by raising
-- HS001 against itself, so every insert inside it is discarded. PL/pgSQL
-- variables are not database state and survive that unwind, which is what lets
-- the result be assembled inside and returned outside. Nothing is ever
-- committed, so Realtime -- which reads committed WAL -- broadcasts nothing
-- either, and the other team's board never so much as flickers.
--
-- It deliberately does NOT call `add_evidence`. That would be a higher-fidelity
-- test, but it fires the shot on completion, and `fire_tile` wants ships placed
-- and a game under way -- neither of which is true of a board still being
-- built, which is exactly when this is useful. So it plays the parts that are
-- about the TILE (what a drop is worth, whether it is refused, whether the rule
-- is satisfied) and leaves the parts that are about the GAME alone.

create or replace function admin_test_tile(p_tile_id uuid, p_picks jsonb default '[]'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tile   tiles%rowtype;
  v_team   uuid;
  v_claim  uuid;
  v_steps  jsonb := '[]'::jsonb;
  v_done   boolean := false;
  v_at     int;
  v_total  int := 0;
  v_count  int := 0;
  v_n      int := 0;
  v_pick   jsonb;
  v_opt    tile_options%rowtype;
  v_award  int;
  v_refuse text;
  v_label  text;
  v_error  text;
begin
  if not is_admin() then raise exception 'Admins only'; end if;

  select * into v_tile from tiles where id = p_tile_id;
  if not found then raise exception 'No such tile'; end if;

  -- Any team in the game will do: nothing here is scored against them and none
  -- of it survives the block. A game with no teams yet has nothing to hang a
  -- claim on, which is worth saying plainly rather than failing on a not-null.
  select id into v_team from teams where game_id = v_tile.game_id
   order by slot nulls last, created_at limit 1;
  if v_team is null then
    raise exception 'This game has no teams yet, so there is nothing to test a claim against';
  end if;

  begin
    insert into tile_claims (tile_id, team_id, status)
    values (p_tile_id, v_team, 'active')
    returning id into v_claim;

    for v_pick in
      select value from jsonb_array_elements(
        case when jsonb_typeof(p_picks) = 'array' then p_picks else '[]'::jsonb end)
    loop
      v_n     := v_n + 1;
      v_opt   := null;
      v_refuse := null;
      v_award := 1;

      if v_tile.completion = 'value' then
        v_award := coalesce((nullif(btrim(v_pick ->> 'amount'), ''))::int, 0);
        v_label := v_award || 'm';
        if v_award < 1 or v_award > 1000 then
          v_refuse := 'That value must be between 1 and 1000';
        end if;

      elsif exists (select 1 from tile_options where tile_id = p_tile_id) then
        select * into v_opt from tile_options
         where id = (nullif(btrim(v_pick ->> 'option_id'), ''))::uuid
           and tile_id = p_tile_id;
        if not found then
          v_label  := '(no drop chosen)';
          v_refuse := 'Say which drop this screenshot shows';
        else
          v_label  := v_opt.label;
          v_refuse := evidence_refusal(v_claim, v_opt.id);
          v_award  := case when v_tile.completion in ('one_set', 'each_set')
                           then 1 else v_opt.points end;
        end if;

      else
        -- A plain tile banks a point per screenshot and asks nothing else.
        v_label := 'Screenshot';
      end if;

      if v_refuse is null then
        insert into tile_evidence (claim_id, team_id, storage_path,
                                   uploaded_by_name, option_id, points)
        values (v_claim, v_team, 'dry-run/' || v_n, 'tile test',
                case when v_opt.id is null then null else v_opt.id end, v_award);
        v_total := v_total + v_award;
        v_count := v_count + 1;
        if not v_done and claim_is_complete(v_claim) then
          v_done := true;
          v_at   := v_n;
        end if;
      end if;

      v_steps := v_steps || jsonb_build_object(
        'n',        v_n,
        'label',    v_label,
        'awarded',  case when v_refuse is null then v_award else 0 end,
        'total',    v_total,
        'count',    v_count,
        'complete', v_done,
        'refused',  v_refuse
      );
    end loop;

    -- Unwinds everything above. See the note on this function.
    raise exception 'dry run complete' using errcode = 'HS001';

  exception
    when sqlstate 'HS001' then
      null;
    when others then
      -- A trigger said no -- the active-claim limit, most likely, if this game
      -- is under way and the chosen team already has its hands full. Reported
      -- rather than thrown, so the builder can say which part failed.
      v_error := sqlerrm;
  end;

  return jsonb_build_object(
    'rule',              v_tile.completion::text,
    'required',          coalesce(v_tile.required_evidence, 1),
    'per_set',           v_tile.per_set,
    'priced',            exists (select 1 from tile_options where tile_id = p_tile_id),
    'complete',          v_done,
    'completed_at_step', v_at,
    'points_total',      v_total,
    'accepted',          v_count,
    'steps',             v_steps,
    'error',             v_error
  );
end;
$$;

revoke execute on function admin_test_tile(uuid, jsonb) from public, anon;
grant  execute on function admin_test_tile(uuid, jsonb) to authenticated;
