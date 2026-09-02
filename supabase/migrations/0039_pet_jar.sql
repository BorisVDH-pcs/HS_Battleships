-- The Pet Jar mechanic: submit a pet or a jar, earn one preview, spend it to
-- see a claimable tile's task without learning whether it hides a ship.
--
-- Decisions made for this first cut (open questions the README left open):
--   - A preview can target any tile this team could currently claim (i.e. one
--     it has not already claimed) — the same "claimable" a player sees on the
--     enemy grid, not a further-restricted subset.
--   - Spending is one-time per tile per team: once previewed, that tile stays
--     revealed to this team (the same way a claim does) but cannot be
--     re-spent, and does not cost another point if looked at again.
--   - The counter has no cap.
--
-- Everything here mirrors an existing pattern rather than inventing a new
-- one: the submissions table/bucket/RPC mirrors tile_evidence (0021), the
-- preview redaction mirrors tiles_for_me's claim-gated reveal, and the
-- event-privacy mirrors evidence_submitted/slot_freed (0035/0036).

-- ============================================================
-- 1. The counter
-- ============================================================

alter table teams add column if not exists pet_jar_count smallint not null default 0
  check (pet_jar_count >= 0);

-- ============================================================
-- 2. Submissions — the resource that earns a preview
-- ============================================================

create table if not exists pet_jar_submissions (
  id                uuid        primary key default gen_random_uuid(),
  game_id           uuid        not null references games(id) on delete cascade,
  team_id           uuid        not null references teams(id) on delete cascade,
  storage_path      text        not null,
  submitted_by      uuid        not null references profiles(id),
  submitted_by_name text        not null,
  created_at        timestamptz not null default now()
);

alter table pet_jar_submissions enable row level security;

-- Same shape as tile_evidence: a team can see its own submissions, an admin
-- sees everything, and there is no update/delete — submissions are immutable.
create policy pet_jar_submissions_read on pet_jar_submissions
  for select using (is_admin() or team_id in (select my_team_ids()));

revoke insert, update, delete on pet_jar_submissions from anon, authenticated;

-- ============================================================
-- 3. Previews — one-time spend record, and what unlocks the reveal
-- ============================================================

create table if not exists pet_jar_previews (
  id         uuid        primary key default gen_random_uuid(),
  game_id    uuid        not null references games(id) on delete cascade,
  team_id    uuid        not null references teams(id) on delete cascade,
  tile_id    uuid        not null references tiles(id) on delete cascade,
  spent_by   uuid        not null references profiles(id),
  created_at timestamptz not null default now(),
  unique (team_id, tile_id)
);

alter table pet_jar_previews enable row level security;
create policy pet_jar_previews_read on pet_jar_previews
  for select using (is_admin() or team_id in (select my_team_ids()));

revoke insert, update, delete on pet_jar_previews from anon, authenticated;

-- ============================================================
-- 4. Storage — a sibling bucket to `evidence`, not a reuse of it
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pet-jar', 'pet-jar', false, 3145728,
        array['image/webp', 'image/png', 'image/jpeg'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy pet_jar_objects_read on storage.objects
  for select using (
    bucket_id = 'pet-jar' and (
      is_admin() or
      (storage.foldername(name))[2] in (select t::text from my_team_ids() t)
    )
  );

create policy pet_jar_objects_write on storage.objects
  for insert with check (
    bucket_id = 'pet-jar' and
    (storage.foldername(name))[2] in (select t::text from my_team_ids() t)
  );

-- ============================================================
-- 5. Submit — registers the upload and credits the counter
-- ============================================================

create function submit_pet_jar(p_game_id uuid, p_storage_path text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_team_id uuid;
  v_name    text;
  v_prefix  text;
  v_row     pet_jar_submissions;
  v_count   smallint;
begin
  v_team_id := my_team_in_game(p_game_id);
  if v_team_id is null then raise exception 'You are not a member of a team in this game'; end if;

  v_prefix := p_game_id || '/' || v_team_id || '/';
  if position(v_prefix in p_storage_path) <> 1 then
    raise exception 'That submission path does not belong to your team';
  end if;

  select display_name into v_name from profiles where id = auth.uid();

  insert into pet_jar_submissions (game_id, team_id, storage_path, submitted_by, submitted_by_name)
  values (p_game_id, v_team_id, p_storage_path, auth.uid(), coalesce(v_name, 'unknown'))
  returning * into v_row;

  update teams set pet_jar_count = pet_jar_count + 1
   where id = v_team_id
   returning pet_jar_count into v_count;

  insert into game_events (game_id, team_id, type, payload)
  values (p_game_id, v_team_id, 'pet_jar_submitted',
          jsonb_build_object(
            'submission_id', v_row.id,
            'submitted_by_name', coalesce(v_name, 'unknown'),
            'pet_jar_count', v_count
          ));

  return jsonb_build_object('submission_id', v_row.id, 'pet_jar_count', v_count);
end;
$$;

revoke execute on function submit_pet_jar(uuid, text) from public, anon;
grant  execute on function submit_pet_jar(uuid, text) to authenticated;

-- ============================================================
-- 6. Spend — previews a claimable tile's task, decrements the counter
-- ============================================================

create function spend_pet_jar(p_tile_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tile    tiles%rowtype;
  v_team_id uuid;
  v_count   smallint;
begin
  select * into v_tile from tiles where id = p_tile_id;
  if not found then raise exception 'No such tile'; end if;

  v_team_id := my_team_in_game(v_tile.game_id);
  if v_team_id is null then raise exception 'You are not a member of a team in this game'; end if;

  if (select status from games where id = v_tile.game_id) <> 'active' then
    raise exception 'The game is not active';
  end if;

  -- Locked so two players spending at once can't both pass the > 0 check.
  select pet_jar_count into v_count from teams where id = v_team_id for update;
  if v_count <= 0 then raise exception 'No pet jar previews left to spend'; end if;

  if exists (select 1 from tile_claims where tile_id = p_tile_id and team_id = v_team_id) then
    raise exception 'Your team has already claimed that tile';
  end if;

  if exists (select 1 from pet_jar_previews where tile_id = p_tile_id and team_id = v_team_id) then
    raise exception 'Your team has already previewed that tile';
  end if;

  insert into pet_jar_previews (game_id, team_id, tile_id, spent_by)
  values (v_tile.game_id, v_team_id, p_tile_id, auth.uid());

  update teams set pet_jar_count = pet_jar_count - 1 where id = v_team_id
   returning pet_jar_count into v_count;

  insert into game_events (game_id, team_id, type, payload)
  values (v_tile.game_id, v_team_id, 'pet_jar_spent',
          jsonb_build_object(
            'tile_id', v_tile.id, 'position', v_tile.position,
            'tile_name', v_tile.name, 'pet_jar_count', v_count
          ));

  -- Task fields only — never claim_result or anything ship-related, and that
  -- stays true even once the tile is later claimed and fired: a preview row
  -- is not a claim row, so it never joins to ships or tile_claims.result.
  return jsonb_build_object('name', v_tile.name, 'icon', v_tile.icon, 'pet_jar_count', v_count);
end;
$$;

revoke execute on function spend_pet_jar(uuid) from public, anon;
grant  execute on function spend_pet_jar(uuid) to authenticated;

-- ============================================================
-- 7. tiles_for_me — reveal name/icon for a previewed tile too
-- ============================================================
-- A preview persists the same way a claim does: reload the page and the
-- revealed name/icon are still there. Nothing else changes — required_evidence,
-- evidence_count and the claim columns stay gated by the claim alone, so a
-- preview never grants anything evidence- or ship-related.

drop function if exists tiles_for_me(uuid);

create function tiles_for_me(p_game_id uuid)
returns table (
  id uuid, game_id uuid, "row" smallint, col smallint, "position" smallint,
  revealed boolean, name text, icon text,
  required_evidence smallint, evidence_count integer, early_complete boolean,
  claim_id uuid, claim_status claim_status, claim_result shot_result,
  previewed boolean
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
    case when c.id is not null then t.early_complete end as early_complete,
    c.id, c.status, c.result,
    (pv.id is not null) as previewed
  from tiles t
  left join tile_claims c on c.tile_id = t.id
       and c.team_id = my_team_in_game(p_game_id)
  left join pet_jar_previews pv on pv.tile_id = t.id
       and pv.team_id = my_team_in_game(p_game_id)
  where t.game_id = p_game_id
  order by t.position;
$$;

revoke execute on function tiles_for_me(uuid) from public, anon;
grant  execute on function tiles_for_me(uuid) to authenticated;

-- ============================================================
-- 8. Discord: team-private routing and lines
-- ============================================================

create or replace function is_team_private_event(p_type event_type)
returns boolean
language sql immutable as $$
  select p_type = any(array[
    'evidence_submitted', 'slot_freed', 'pet_jar_submitted', 'pet_jar_spent'
  ]::event_type[]);
$$;

drop policy if exists events_read on game_events;

create policy events_read on game_events for select using (
  not is_team_private_event(type)
  or team_id in (select my_team_ids())
  or is_admin()
);

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
    when 'evidence_submitted' then format('**%s** submitted proof for **%s** (%s/%s) — %s tile(s) left to fire.',
                                     coalesce(p_event.payload ->> 'uploaded_by_name', v_team),
                                     coalesce(p_event.payload ->> 'tile_name', 'a tile'),
                                     p_event.payload ->> 'evidence_count',
                                     p_event.payload ->> 'required_evidence',
                                     p_event.payload ->> 'tiles_left_to_fire')
    when 'slot_freed'    then 'A slot is free to claim.'
    when 'pet_jar_submitted' then format(':jar: **%s** submitted a pet/jar — %s pet jar preview(s) now.',
                                     coalesce(p_event.payload ->> 'submitted_by_name', v_team),
                                     p_event.payload ->> 'pet_jar_count')
    when 'pet_jar_spent' then format(':mag: A pet jar preview was spent on **%s** — %s left.',
                                     coalesce(p_event.payload ->> 'tile_name', 'a tile'),
                                     p_event.payload ->> 'pet_jar_count')
    else p_event.type::text
  end;
end;
$$;

revoke execute on function is_team_private_event(event_type) from public, anon;
grant  execute on function is_team_private_event(event_type) to authenticated;
revoke execute on function discord_line(game_events) from public, anon, authenticated;
