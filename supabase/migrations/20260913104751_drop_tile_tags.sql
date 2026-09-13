-- Labels leave the catalogue.
--
-- The timestamp is the moment this was applied to the live project by hand,
-- not a round number chosen when it was written. That is deliberate: the
-- applied version is what `supabase_migrations.schema_migrations` holds, and a
-- file numbered anything else is a migration `supabase db push` believes is
-- still pending and tries to run a second time.
--
-- A tile could carry free-text labels, and a label could scope the random deal
-- and filter the catalogue list. The catalogue held exactly one of them,
-- "Battleships V4" on 86 entries -- and the distinct tiles of the saved board
-- of the same name were those same 86, exactly. Two names for one set.
--
-- Saved boards do the job better. A board is stored with a frozen copy of every
-- square AND its library_id, so it keeps positions, keeps a tile deliberately
-- placed three times, and survives a catalogue edit -- none of which a label can
-- do. Reproducing a board is Load. A random arrangement of that board's tiles is
-- Load then Shuffle. Neither needs a label.
--
-- What the deal loses is the ability to draw from a subset, and it loses it on
-- purpose: the only subset anyone had was the one the saved board already
-- describes. Dealing now draws from the whole catalogue, which is exactly what
-- it did before labels existed.
--
-- The other half of the reason is that labels did not work. `tags` was written
-- through `lower(btrim(...))` from the first migration -- deliberately, so a
-- label was a case-insensitive identity and duplicates were impossible. The 86
-- capitalised ones were written around that function and therefore sat outside
-- its guarantee: editing any of them through the form would silently lower-case
-- the label and split the set again, one tile at a time. Rather than choose
-- between honouring the lower-casing and replacing it with a spelling-preserving
-- match, the concept goes.

-- ---------------------------------------------------------------------------
-- 1. The deal stops taking a label.
--
-- Both signatures dropped, not just the old two-argument one. Dropping only
-- what this migration replaces is the obvious way to write it and the wrong
-- one: replayed against a database that already has the new function, a bare
-- `create` fails on a signature nothing dropped. Which is exactly how this
-- migration failed its first CI run.
-- ---------------------------------------------------------------------------
drop function if exists admin_autofill_board(uuid, text);
drop function if exists admin_autofill_board(uuid);

create function admin_autofill_board(p_game_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_game   games%rowtype;
  v_result jsonb;
begin
  if not is_admin() then raise exception 'Admins only'; end if;

  select * into v_game from games where id = p_game_id;
  if not found then raise exception 'No such game'; end if;
  if v_game.status not in ('setup', 'placement') then
    raise exception 'Tiles are locked once the game is %', v_game.status;
  end if;

  with empty as materialized (
    select r.n::smallint as "row", c.n::smallint as col,
           row_number() over (order by random()) as slot
      from generate_series(1, v_game.grid_size) as r(n)
      cross join generate_series(1, v_game.grid_size) as c(n)
     where not exists (
             select 1 from tiles t
              where t.game_id = p_game_id and t.row = r.n and t.col = c.n)
  ),
  taken as materialized (
    select tile_name_key(t.name) as name_key,
           tile_task_key(t.name) as task_key
      from tiles t where t.game_id = p_game_id
  ),
  pool as materialized (
    select l.id, tile_task_key(l.name) as task_key
      from tile_library l
     where tile_name_key(l.name) not in (select name_key from taken)
       and not (l.completion in ('one_set', 'each_set')
                and not exists (select 1 from tile_library_options o
                                 where o.library_id = l.id))
       and not (l.completion = 'value'
                and exists (select 1 from tile_library_options o
                             where o.library_id = l.id))
  ),
  first_choice as materialized (
    select distinct on (p.task_key) p.id
      from pool p
     where p.task_key not in (select task_key from taken)
     order by p.task_key, random()
  ),
  ranked as materialized (
    select f.id, 0 as tier, row_number() over (order by random()) as ord
      from first_choice f
    union all
    select p.id, 1 as tier, row_number() over (order by random()) as ord
      from pool p
     where p.id not in (select id from first_choice)
  ),
  chosen as materialized (
    select r.id, r.tier, row_number() over (order by r.tier, r.ord) as slot
      from ranked r
  ),
  plan as materialized (
    select e."row", e.col, c.id as library_id, c.tier
      from empty e join chosen c on c.slot = e.slot
  ),
  ins as (
    insert into tiles (game_id, "row", col, name, icon, required_evidence,
                       description, completion, per_set, library_id)
    select p_game_id, pl."row", pl.col, l.name, l.icon, l.required_evidence,
           l.description, l.completion, l.per_set, l.id
      from plan pl join tile_library l on l.id = pl.library_id
    returning id, library_id
  ),
  opts as (
    insert into tile_options (tile_id, label, points, sort, grp, max_times)
    select i.id, o.label, o.points, o.sort, o.grp, o.max_times
      from ins i join tile_library_options o on o.library_id = i.library_id
    returning 1
  ),
  bumped as (
    update tile_library l
       set times_used = l.times_used + 1, last_used_at = now()
      from ins i where l.id = i.library_id
    returning 1
  )
  select jsonb_build_object(
           'filled',  (select count(*) from plan),
           'similar', (select count(*) from plan where tier = 1),
           'empty',   (select count(*) from empty),
           'pool',    (select count(*) from pool)
         )
    into v_result;

  return v_result;
end;
$$;

grant execute on function admin_autofill_board(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The catalogue stops returning a labels column.
--    Dropped rather than replaced: the return type changes, which
--    CREATE OR REPLACE cannot do.
-- ---------------------------------------------------------------------------
drop function if exists admin_list_library();

create function admin_list_library()
returns table (
  id uuid, name text, icon text, description text,
  required_evidence smallint, completion text, per_set smallint,
  times_used integer, last_used_at timestamptz, options jsonb
)
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  return query
    select l.id, l.name, l.icon, l.description,
           l.required_evidence,
           l.completion::text, l.per_set,
           l.times_used, l.last_used_at,
           (select coalesce(jsonb_agg(jsonb_build_object(
                     'label', o.label, 'points', o.points, 'grp', o.grp,
                     'max_times', o.max_times
                   ) order by o.sort, o.label), '[]'::jsonb)
              from tile_library_options o where o.library_id = l.id)
      from tile_library l
     order by l.times_used desc, l.last_used_at desc nulls last, l.name;
end;
$$;

grant execute on function admin_list_library() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Saving a catalogue tile stops writing labels.
--    Same signature, so a plain replace -- `p_tile -> 'tags'` is simply no
--    longer read, and a client that still sends one is ignored rather than
--    refused.
-- ---------------------------------------------------------------------------
create or replace function admin_save_library_tile(p_id uuid, p_tile jsonb)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id         uuid;
  v_completion tile_completion;
  v_options    int;
  v_name       text;
  v_amount     int;
begin
  if not is_admin() then raise exception 'Admins only'; end if;

  v_name := btrim(coalesce(p_tile ->> 'name', ''));
  if v_name = '' then raise exception 'A library tile needs a name'; end if;

  v_completion := coalesce(nullif(btrim(coalesce(p_tile ->> 'rule', '')), ''),
                           'points')::tile_completion;
  -- A value tile's target is in tenths of a million; every other rule's is a
  -- small count. The ceiling is the same 1000m it always was, said in the unit
  -- the column now holds -- without this a 250m tile saves as 100m.
  v_amount := least(greatest(coalesce((nullif(btrim(p_tile ->> 'amount'), ''))::int, 1), 1),
                    case when v_completion = 'value' then 10000 else 1000 end);
  v_options := (
    select count(*)
      from jsonb_array_elements(
             case when jsonb_typeof(p_tile -> 'options') = 'array'
                  then p_tile -> 'options' else '[]'::jsonb end) o
     where btrim(coalesce(o ->> 'label', '')) <> ''
  );
  perform assert_tile_rule_ok(v_completion, v_options, format('%L', v_name));
  perform assert_points_cap_reachable(v_completion, v_amount,
                                      p_tile -> 'options', format('%L', v_name));

  begin
    insert into tile_library (id, name, icon, description, required_evidence,
                              completion, per_set, created_by)
    values (
      coalesce(p_id, gen_random_uuid()),
      left(v_name, 120),
      nullif(regexp_replace(btrim(coalesce(p_tile ->> 'icon', '')),
                            '[^A-Za-z0-9_-]', '', 'g'), ''),
      nullif(left(btrim(coalesce(p_tile ->> 'description', '')), 500), ''),
      v_amount,
      v_completion,
      least(greatest(coalesce((nullif(btrim(p_tile ->> 'perSet'), ''))::smallint, 1), 1), 30),
      auth.uid()
    )
    on conflict (id) do update set
      name              = excluded.name,
      icon              = excluded.icon,
      description       = excluded.description,
      required_evidence = excluded.required_evidence,
      completion        = excluded.completion,
      per_set           = excluded.per_set
    returning tile_library.id into v_id;
  exception when unique_violation then
    raise exception 'A library tile called % already exists', v_name;
  end;

  delete from tile_library_options where library_id = v_id;

  insert into tile_library_options (library_id, label, points, sort, grp, max_times)
  select v_id,
         left(btrim(o.val ->> 'label'), 80),
         least(greatest(coalesce((o.val ->> 'points')::smallint, 1), 1), 30),
         (o.ord - 1)::smallint,
         nullif(left(btrim(coalesce(o.val ->> 'grp', '')), 40), ''),
         case when nullif(btrim(coalesce(o.val ->> 'maxTimes', '')), '') is null then null
              else least(greatest((o.val ->> 'maxTimes')::smallint, 1), 30)::smallint end
    from jsonb_array_elements(
           case when jsonb_typeof(p_tile -> 'options') = 'array'
                then p_tile -> 'options' else '[]'::jsonb end
         ) with ordinality as o(val, ord)
   where btrim(coalesce(o.val ->> 'label', '')) <> '';

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The column itself. Last, so nothing above is reading it when it goes.
--    No index and no constraint depends on it. `if exists` for the same reason
--    as the drops above: a migration that cannot be replayed is a migration
--    that only works once, on one database.
-- ---------------------------------------------------------------------------
alter table tile_library drop column if exists tags;
