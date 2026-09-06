-- ============================================================
-- Fill the empty squares of a board from the catalogue, at random
-- ============================================================
-- Three events in, most of a board is tasks that have been run before, and the
-- catalogue now holds more of them than a board has squares. So the first draft
-- of a board is a job a shuffle can do: deal out tiles, then spend the evening
-- on the handful that want thinking about rather than on all hundred.
--
-- It only ever fills squares that are empty. A board half-built by hand is the
-- normal case -- two organisers splitting an evening, or one who has placed the
-- dozen tiles they care about -- and the one thing that must never happen is
-- that pressing a convenience button throws that away. Nothing already on the
-- board is touched, and nothing already on the board is dealt a second time.

-- The task a tile name describes, with the counting taken out.
--
-- `tile_name_key` already answers "is this the same entry" for the catalogue's
-- unique index. This answers the softer question the shuffle needs: are these
-- two the same job. Numbers and punctuation go, so "5 Fang kits" and "7 Fang
-- kits" collapse to one task -- which is exactly the pair the copy button in
-- the builder is built to produce, and exactly the pair that reads as a mistake
-- when it turns up twice on one board.
--
-- Deliberately blunt. It will not catch two different wordings of one job, and
-- it is not trying to: a false positive here costs a tile its place on a board,
-- and the fallback below means a miss costs nothing at all.
-- The lone `x` is the multiplier in "Fang kits x12". Stripping the digits
-- leaves it behind as a word, which is enough to make that entry look like a
-- different task from "5 Fang kits" -- the one comparison this function exists
-- to get right. Padded with spaces so a leading or trailing `x` is matched by
-- the same pass as one in the middle.
create or replace function tile_task_key(p_name text)
returns text
language sql immutable strict set search_path = public as $fn$
  select btrim(regexp_replace(
           replace(' ' || regexp_replace(lower(p_name), '[^a-z]+', ' ', 'g') || ' ',
                   ' x ', ' '),
           '\s+', ' ', 'g'));
$fn$;

create or replace function admin_autofill_board(p_game_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
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

  -- One statement, so a board is never half-dealt. Every CTE that uses
  -- random() is `materialized`: an inlined CTE referenced twice would be
  -- evaluated twice, and two different shuffles would put a tile in one place
  -- and its drops in another.
  with empty as materialized (
    select r.n::smallint as "row", c.n::smallint as col,
           row_number() over (order by random()) as slot
      from generate_series(1, v_game.grid_size) as r(n)
      cross join generate_series(1, v_game.grid_size) as c(n)
     where not exists (
             select 1 from tiles t
              where t.game_id = p_game_id and t.row = r.n and t.col = c.n)
  ),

  -- What the board already holds. Both keys, because a tile already placed
  -- rules out its own entry outright and makes its task merely undesirable.
  taken as materialized (
    select tile_name_key(t.name) as name_key,
           tile_task_key(t.name) as task_key
      from tiles t where t.game_id = p_game_id
  ),

  -- Everything the shuffle is allowed to deal. The rule check is defensive
  -- rather than expected: `admin_save_library_tile` refuses a set tile with no
  -- drops, so one should not exist -- but a board dealt from a broken entry
  -- would be a tile no team could ever finish, discovered mid-event, and the
  -- cost of not dealing it is that a square stays empty for someone to notice.
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

  -- The preferred tier: one entry per task, and no task the board already has.
  -- `distinct on` with a random tiebreak means which variant of a task gets
  -- dealt is itself a shuffle, rather than always the alphabetically first.
  first_choice as materialized (
    select distinct on (p.task_key) p.id
      from pool p
     where p.task_key not in (select task_key from taken)
     order by p.task_key, random()
  ),

  -- Tier 1 is everything else -- the variants that lost the draw above, and the
  -- tasks the board already has in another form. They are dealt only after the
  -- distinct ones run out, which is what "similar tasks may share a board, but
  -- only if that is what it takes to fill it" means in practice.
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

  -- An inner join, so a catalogue too small for the board fills what it can and
  -- leaves the rest empty rather than failing. Ninety-two squares dealt and
  -- eight to think about is a useful evening; an error message is not.
  plan as materialized (
    select e."row", e.col, c.id as library_id, c.tier
      from empty e join chosen c on c.slot = e.slot
  ),

  ins as (
    insert into tiles (game_id, "row", col, name, icon, required_evidence,
                       early_complete, description, completion, per_set, library_id)
    select p_game_id, pl."row", pl.col, l.name, l.icon, l.required_evidence,
           l.early_complete, l.description, l.completion, l.per_set, l.id
      from plan pl join tile_library l on l.id = pl.library_id
    returning id, library_id
  ),

  -- Safe to join on `library_id` because the pool excluded every name the board
  -- already had and deals each entry at most once, so among these rows the id
  -- identifies exactly one square.
  opts as (
    insert into tile_options (tile_id, label, points, sort, grp)
    select i.id, o.label, o.points, o.sort, o.grp
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

revoke execute on function admin_autofill_board(uuid) from public, anon;
grant  execute on function admin_autofill_board(uuid) to authenticated;
