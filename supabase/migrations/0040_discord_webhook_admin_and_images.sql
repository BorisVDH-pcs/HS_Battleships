-- Two things: an admin UI needs a write surface for `discord_webhooks`, and the
-- team-private Discord lines (evidence_submitted, pet_jar_submitted) start
-- carrying the actual screenshot, not just a line describing it.
--
-- ============================================================
-- 1. Images: an imgbb URL riding alongside the storage path
-- ============================================================
-- The private Supabase bucket stays the source of truth (secret #2 lives
-- there); `public_url` is a second, public copy uploaded client-side to
-- imgbb purely so Discord's embed unfurler has something it can fetch
-- without a signed-URL dance. Nullable: if imgbb is unreachable or unconfigured
-- the evidence/submission still saves, it just posts as text-only, same as
-- before this migration.

alter table tile_evidence        add column if not exists public_url text;
alter table pet_jar_submissions  add column if not exists public_url text;

drop function if exists add_evidence(uuid, text);

create function add_evidence(p_claim_id uuid, p_storage_path text, p_public_url text default null)
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

  select display_name into v_name from profiles where id = auth.uid();

  insert into tile_evidence (claim_id, team_id, storage_path, uploaded_by, uploaded_by_name, public_url)
  values (p_claim_id, v_claim.team_id, p_storage_path, auth.uid(),
          coalesce(v_name, 'unknown'), nullif(btrim(coalesce(p_public_url, '')), ''))
  returning * into v_row;

  select count(*) into v_have from tile_evidence where claim_id = p_claim_id;
  v_required := coalesce(v_tile.required_evidence, 1);
  v_will_fire := v_have >= v_required;

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
            'image_url', v_row.public_url
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
    'fired',             v_result is not null,
    'result',            v_result
  );
end;
$$;

revoke execute on function add_evidence(uuid, text, text) from public, anon;
grant  execute on function add_evidence(uuid, text, text) to authenticated;

-- ------------------------------------------------------------

drop function if exists submit_pet_jar(uuid, text);

create function submit_pet_jar(p_game_id uuid, p_storage_path text, p_public_url text default null)
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

  insert into pet_jar_submissions (game_id, team_id, storage_path, submitted_by, submitted_by_name, public_url)
  values (p_game_id, v_team_id, p_storage_path, auth.uid(), coalesce(v_name, 'unknown'),
          nullif(btrim(coalesce(p_public_url, '')), ''))
  returning * into v_row;

  update teams set pet_jar_count = pet_jar_count + 1
   where id = v_team_id
   returning pet_jar_count into v_count;

  insert into game_events (game_id, team_id, type, payload)
  values (p_game_id, v_team_id, 'pet_jar_submitted',
          jsonb_build_object(
            'submission_id', v_row.id,
            'submitted_by_name', coalesce(v_name, 'unknown'),
            'pet_jar_count', v_count,
            'image_url', v_row.public_url
          ));

  return jsonb_build_object('submission_id', v_row.id, 'pet_jar_count', v_count);
end;
$$;

revoke execute on function submit_pet_jar(uuid, text, text) from public, anon;
grant  execute on function submit_pet_jar(uuid, text, text) to authenticated;

-- ============================================================
-- 2. discord_line: append the image as its own line
-- ============================================================
-- Its own line, not inlined into the sentence, because Discord only unfurls a
-- URL that sits on a line by itself (or close to it) into an inline image.

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
                                   || case when v_img is not null then E'\n' || v_img else '' end
    when 'slot_freed'    then 'A slot is free to claim.'
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

-- ============================================================
-- 3. Admin write surface for discord_webhooks
-- ============================================================
-- The table itself stays RLS-on-with-no-policies (0032): nothing short of a
-- definer function or the service role can touch it. These three are that
-- surface, gated by is_admin() like every other admin_* function.

-- At most one "general" row (team_id null) and one row per team, per game —
-- matching how relay_pending already picks "the" webhook for each.
create unique index if not exists discord_webhooks_general_uniq
  on discord_webhooks (game_id) where team_id is null;
create unique index if not exists discord_webhooks_team_uniq
  on discord_webhooks (game_id, team_id) where team_id is not null;

create or replace function admin_list_webhooks(p_game_id uuid)
returns table (id uuid, team_id uuid, team_name text, label text, url text,
               enabled boolean, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  return query
    select w.id, w.team_id, tm.name, w.label, w.url, w.enabled, w.created_at
      from discord_webhooks w
      left join teams tm on tm.id = w.team_id
     where w.game_id = p_game_id
     order by w.team_id nulls first;
end;
$$;

revoke execute on function admin_list_webhooks(uuid) from public, anon;
grant  execute on function admin_list_webhooks(uuid) to authenticated;

-- Upsert on (game_id, team_id): one call sets or replaces that channel's URL.
create or replace function admin_set_webhook(
  p_game_id uuid, p_team_id uuid, p_url text,
  p_enabled boolean default true, p_label text default null
)
returns discord_webhooks
language plpgsql security definer set search_path = public as $$
declare
  v_row discord_webhooks;
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if p_url is null or btrim(p_url) = '' then raise exception 'A webhook needs a URL'; end if;
  if p_team_id is not null
     and not exists (select 1 from teams where id = p_team_id and game_id = p_game_id) then
    raise exception 'That team is not in this game';
  end if;

  update discord_webhooks
     set url = btrim(p_url), enabled = p_enabled,
         label = coalesce(nullif(btrim(p_label), ''), label)
   where game_id = p_game_id and team_id is not distinct from p_team_id
   returning * into v_row;

  if not found then
    insert into discord_webhooks (game_id, team_id, label, url, enabled)
    values (p_game_id, p_team_id,
            coalesce(nullif(btrim(p_label), ''),
                     case when p_team_id is null then 'general' else 'team' end),
            btrim(p_url), p_enabled)
    returning * into v_row;
  end if;

  return v_row;
end;
$$;

revoke execute on function admin_set_webhook(uuid, uuid, text, boolean, text) from public, anon;
grant  execute on function admin_set_webhook(uuid, uuid, text, boolean, text) to authenticated;

create or replace function admin_delete_webhook(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  delete from discord_webhooks where id = p_id;
end;
$$;

revoke execute on function admin_delete_webhook(uuid) from public, anon;
grant  execute on function admin_delete_webhook(uuid) to authenticated;
