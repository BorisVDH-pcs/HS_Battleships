-- Evidence: proof that a tile's task was actually done.
--
-- Some tiles need more than one completion, so `tiles.required_evidence` is the
-- "amount" column in the admin paste box, and a claim cannot be fired until it
-- has that many images attached.
--
-- Three decisions, made deliberately:
--
--   1. No admin approval step. Uploading is what unlocks the shot. An admin can
--      review everything (admin_list_evidence below), but the game does not
--      stop and wait on a queue mid-event.
--   2. Players cannot delete evidence — there is no delete policy on this table
--      at all, so RLS refuses it for everyone bar the service role. Evidence is
--      the record of why a shot counted; letting a team retract it afterwards
--      would make that record worthless.
--   3. Any team member may submit, not only the captain, and the submitter is
--      logged by id AND by name-as-it-was. Players get renamed (0019 exists for
--      exactly that), and an audit line that silently changes who it names is
--      not an audit line.
--
-- SECURITY: evidence is secret #2 by another route. A screenshot of a tile's
-- task — or a filename naming it — tells the other team what sits on that
-- square. So the bucket is private, rows are team-scoped, and the storage path
-- is built from ids only, never the tile name or its icon slug.

-- ============================================================
-- 1. How many completions a tile needs
-- ============================================================
-- Default 1, so every tile already in the database keeps working untouched.

alter table tiles add column if not exists required_evidence smallint not null default 1
  check (required_evidence between 1 and 10);

-- ============================================================
-- 2. The evidence itself
-- ============================================================
-- Hung off the CLAIM, not the tile: both teams can claim the same square and
-- each needs its own proof. team_id is denormalised so the RLS check stays a
-- single-table lookup — the same reason ship_cells carries one.

create table if not exists tile_evidence (
  id               uuid        primary key default gen_random_uuid(),
  claim_id         uuid        not null references tile_claims(id) on delete cascade,
  team_id          uuid        not null references teams(id) on delete cascade,
  storage_path     text        not null unique,
  uploaded_by      uuid        references profiles(id) on delete set null,
  uploaded_by_name text        not null,
  created_at       timestamptz not null default now()
);

create index if not exists tile_evidence_claim_idx on tile_evidence (claim_id);

alter table tile_evidence enable row level security;

-- A team sees its own evidence; an admin sees all of it.
drop policy if exists evidence_own_team_or_admin on tile_evidence;
create policy evidence_own_team_or_admin on tile_evidence
  for select using (team_id in (select my_team_ids()) or is_admin());

-- Deliberately no insert, update or delete policy. RLS denies what it does not
-- permit, so evidence is append-only through add_evidence() and immutable once
-- written.

-- ============================================================
-- 3. Firing needs the evidence to be there
-- ============================================================
-- On the table rather than inside fire_tile(), following the example of
-- freeze_fleet_after_placement: a rule that lives on the table cannot be
-- stepped around by an RPC, a service-role call, or a hand-written UPDATE.

-- search_path pinned, like every other function here: a trigger that resolves
-- `tiles` through whatever schema happens to be first is a trigger someone can
-- feed a different `tiles`.
create or replace function enforce_evidence_before_fire() returns trigger
language plpgsql set search_path = public as $$
declare
  v_required smallint;
  v_have     int;
begin
  if new.status <> 'fired' or old.status = 'fired' then
    return new;
  end if;

  select required_evidence into v_required from tiles where id = new.tile_id;
  select count(*) into v_have from tile_evidence where claim_id = new.id;

  if v_have < coalesce(v_required, 1) then
    raise exception 'This tile needs % piece(s) of evidence, and has %',
      coalesce(v_required, 1), v_have;
  end if;

  return new;
end;
$$;

drop trigger if exists claims_need_evidence on tile_claims;
create trigger claims_need_evidence
  before update on tile_claims
  for each row execute function enforce_evidence_before_fire();

-- ============================================================
-- 4. Attaching a piece of evidence
-- ============================================================
-- The file goes to storage client-side, then gets registered here. An RPC
-- rather than an insert policy, because it can check what a policy cannot: that
-- the claim is mine, that it is still unfired, and that the path sits inside
-- this claim's own folder rather than another team's.

create or replace function add_evidence(p_claim_id uuid, p_storage_path text)
returns tile_evidence
language plpgsql security definer set search_path = public as $$
declare
  v_claim  tile_claims%rowtype;
  v_tile   tiles%rowtype;
  v_name   text;
  v_prefix text;
  v_row    tile_evidence;
begin
  select * into v_claim from tile_claims where id = p_claim_id;
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

  return v_row;
end;
$$;

revoke execute on function add_evidence(uuid, text) from public, anon;
grant  execute on function add_evidence(uuid, text) to authenticated;

-- ============================================================
-- 5. Reading it back
-- ============================================================

create or replace function my_evidence(p_game_id uuid)
returns table (id uuid, claim_id uuid, storage_path text,
               uploaded_by_name text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select e.id, e.claim_id, e.storage_path, e.uploaded_by_name, e.created_at
    from tile_evidence e
    join tile_claims c on c.id = e.claim_id
    join tiles t on t.id = c.tile_id
   where t.game_id = p_game_id
     and e.team_id in (select my_team_ids())
   order by e.created_at;
$$;

revoke execute on function my_evidence(uuid) from public, anon;
grant  execute on function my_evidence(uuid) to authenticated;

-- The organiser's review. This names the tile and the team together, which is
-- precisely what must never cross the line — hence the is_admin() gate.
create or replace function admin_list_evidence(p_game_id uuid)
returns table (id uuid, claim_id uuid, storage_path text, uploaded_by_name text,
               created_at timestamptz, team_id uuid, team_name text,
               tile_position smallint, tile_name text, status claim_status)
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  return query
    select e.id, e.claim_id, e.storage_path, e.uploaded_by_name, e.created_at,
           e.team_id, tm.name, t.position, t.name, c.status
      from tile_evidence e
      join tile_claims c on c.id = e.claim_id
      join tiles t on t.id = c.tile_id
      join teams tm on tm.id = e.team_id
     where t.game_id = p_game_id
     order by e.created_at desc;
end;
$$;

revoke execute on function admin_list_evidence(uuid) from public, anon;
grant  execute on function admin_list_evidence(uuid) to authenticated;

-- ============================================================
-- 6. The board needs to know the count
-- ============================================================
-- tiles_for_me gains the requirement and how much of it is met. Both are
-- redacted for an unclaimed tile, exactly as the name and icon are: "this one
-- needs three completions" is a hint about what the tile is.
--
-- RETURNS TABLE cannot be changed by `create or replace`, so this drops and
-- recreates — which drops the grants with it. They are re-applied below. Miss
-- that and every player loses the board (see 0014).

drop function if exists tiles_for_me(uuid);

create function tiles_for_me(p_game_id uuid)
returns table (
  id uuid, game_id uuid, "row" smallint, col smallint, "position" smallint,
  revealed boolean, name text, icon text,
  required_evidence smallint, evidence_count int,
  claim_id uuid, claim_status claim_status, claim_result shot_result
)
language sql stable security definer set search_path = public as $$
  select t.id, t.game_id, t.row, t.col, t.position,
    (c.id is not null) as revealed,
    case when c.id is not null then t.name end as name,
    case when c.id is not null then t.icon end as icon,
    case when c.id is not null then t.required_evidence end as required_evidence,
    case when c.id is not null
         then (select count(*) from tile_evidence e where e.claim_id = c.id)
         else 0 end::int as evidence_count,
    c.id, c.status, c.result
  from tiles t
  left join tile_claims c on c.tile_id = t.id
       and c.team_id in (select my_team_ids())
  where t.game_id = p_game_id
  order by t.position;
$$;

revoke execute on function tiles_for_me(uuid) from public, anon;
grant  execute on function tiles_for_me(uuid) to authenticated;

-- ============================================================
-- 7. The admin's tile list and the paste box
-- ============================================================
-- The paste format grows a third field:  Name | slug | amount
-- Amount is optional and defaults to 1, so the two-field lists already in use
-- still import unchanged.

drop function if exists admin_list_tiles(uuid);

create function admin_list_tiles(p_game_id uuid)
returns table (id uuid, "row" smallint, col smallint, "position" smallint,
               name text, icon text, required_evidence smallint)
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  return query
    select t.id, t.row, t.col, t.position, t.name, t.icon, t.required_evidence
      from tiles t where t.game_id = p_game_id order by t.position;
end;
$$;

revoke execute on function admin_list_tiles(uuid) from public, anon;
grant  execute on function admin_list_tiles(uuid) to authenticated;

create or replace function admin_set_tiles(p_game_id uuid, p_tiles jsonb)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_game  games%rowtype;
  v_count int;
begin
  if not is_admin() then raise exception 'Admins only'; end if;

  select * into v_game from games where id = p_game_id;
  if not found then raise exception 'No such game'; end if;
  if v_game.status not in ('setup', 'placement') then
    raise exception 'Tiles are locked once the game is % ', v_game.status;
  end if;

  v_count := jsonb_array_length(p_tiles);
  if v_count <> v_game.grid_size * v_game.grid_size then
    raise exception 'Expected % tiles, got %', v_game.grid_size * v_game.grid_size, v_count;
  end if;

  delete from tiles where game_id = p_game_id;

  insert into tiles (game_id, row, col, name, icon, required_evidence)
  select p_game_id,
         (t ->> 'row')::smallint,
         (t ->> 'col')::smallint,
         coalesce(nullif(btrim(t ->> 'name'), ''), 'Tile'),
         -- A slug only: strip anything that could turn into a path or a URL,
         -- so a stray paste cannot point the board off-site.
         nullif(regexp_replace(btrim(coalesce(t ->> 'icon', '')),
                               '[^A-Za-z0-9_-]', '', 'g'), ''),
         -- Clamped rather than rejected: a typo in one cell of a 100-row paste
         -- should not throw the whole import away.
         least(greatest(coalesce((nullif(btrim(t ->> 'amount'), ''))::smallint, 1), 1), 10)
    from jsonb_array_elements(p_tiles) t;

  return v_count;
end;
$$;

-- ============================================================
-- 8. Storage
-- ============================================================
-- Private bucket, 3 MB a file, images only. The client downscales before
-- upload; this is the backstop for when it does not.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('evidence', 'evidence', false, 3145728,
        array['image/webp', 'image/png', 'image/jpeg'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Path is {game_id}/{team_id}/{claim_id}/{uuid}.webp, so segment 2 is the team.
-- Compared as text: a malformed path should fail the check, not raise a cast
-- error inside a policy.

drop policy if exists evidence_objects_read on storage.objects;
create policy evidence_objects_read on storage.objects
  for select using (
    bucket_id = 'evidence' and (
      is_admin() or
      (storage.foldername(name))[2] in (select t::text from my_team_ids() t)
    )
  );

drop policy if exists evidence_objects_write on storage.objects;
create policy evidence_objects_write on storage.objects
  for insert with check (
    bucket_id = 'evidence' and
    (storage.foldername(name))[2] in (select t::text from my_team_ids() t)
  );

-- No update or delete policy: evidence is immutable for players, exactly as the
-- rows are. An organiser who genuinely has to remove something does it from the
-- dashboard with the service role.
