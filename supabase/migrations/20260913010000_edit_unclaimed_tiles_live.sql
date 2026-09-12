-- Fixing a square while the game is running.
--
-- Tiles have been frozen at `start_game` since 0006, and the reason is sound:
-- a tile's cost is the deal a team accepted when they locked it in, and a board
-- that changes underneath a team mid-tile is worse than one that cannot change
-- at all. But it also froze the ninety-odd squares NOBODY has touched, and a
-- wrong drop list spotted on one of those in the second hour of an event was
-- simply unfixable -- the tile stayed wrong, and the first team to claim it got
-- the wrong tile.
--
-- A square with no claim on it is concealed. Nobody has seen its name, its
-- price list or its target; there is no evidence against it and no progress to
-- lose. Changing it takes nothing from anyone, because nobody has anything yet.
-- So the freeze narrows from "the whole board once the game starts" to "any
-- square a team has locked in".
--
-- WHAT IS STILL REFUSED, AND WHY IT MATTERS MORE THAN IT LOOKS. A claimed
-- square stays untouchable while the game is active. Not out of caution about
-- fairness alone -- there is a data reason with teeth. `admin_set_tile`
-- replaces a tile's drops wholesale (delete, then re-insert), and
-- `tile_evidence.option_id` is `on delete set null` (0046). Under `points` and
-- `value` that is survivable, because the points were frozen onto the evidence
-- row when it was submitted. Under the three set rules it is not:
-- `claim_is_complete()` matches evidence to options BY `option_id`, so a team
-- sitting at four sets of five would silently drop to zero, with no error and
-- nothing on screen to explain it.
--
-- Editing a claimed tile safely needs options matched by label so the links
-- survive, a refusal when a drop being removed already has evidence against it,
-- and an event so the team can see what changed. That is a different feature
-- and it is deliberately not this one.
--
-- The escape hatch already exists and needs no new code: `admin_release_claim`
-- hands the square back, and an unclaimed square is editable by the rule above.
-- That makes the destructive path explicit and logged rather than hidden inside
-- a tile edit.
--
-- `finished` stays frozen entirely: there is nothing to fix on a board whose
-- game is over, and a rewritten tile would only make the history lie.
--
-- Not changed here, on purpose: `admin_clear_tile`, `admin_clear_board`,
-- `admin_autofill_board` and `admin_apply_board_preset` are all still pre-game
-- only. `start_game` requires exactly grid_size² tiles, so removing one mid-game
-- would leave a live board with a hole in it -- a square the grid draws and no
-- team can claim.
--
-- A caveat worth knowing rather than coding around: a pet jar preview (0039)
-- reveals a tile's NAME and ICON without claiming it. Editing a previewed
-- square is allowed by the rule above, so renaming one makes what that team
-- paid a jar for out of date. Fixing a drop list -- the case this exists for --
-- leaves the preview true, since a preview never showed the drops.

create or replace function admin_set_tile(p_game_id uuid,
                                          p_row smallint,
                                          p_col smallint,
                                          p_tile jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_game       games%rowtype;
  v_tile_id    uuid;
  v_was        uuid;
  v_completion tile_completion;
  v_library    uuid;
  v_options    int;
  v_amount     int;
begin
  if not is_admin() then raise exception 'Admins only'; end if;

  select * into v_game from games where id = p_game_id;
  if not found then raise exception 'No such game'; end if;

  if v_game.status not in ('setup', 'placement', 'active') then
    raise exception 'Tiles are locked once the game is %', v_game.status;
  end if;

  -- Mid-game, only a square nobody has locked in. See the header.
  if v_game.status = 'active' and exists (
       select 1
         from tile_claims c
         join tiles t on t.id = c.tile_id
        where t.game_id = p_game_id and t."row" = p_row and t.col = p_col
     ) then
    raise exception
      'A team has locked that square in — release the claim first, or wait for it to fire';
  end if;

  if p_row < 1 or p_row > v_game.grid_size or p_col < 1 or p_col > v_game.grid_size then
    raise exception 'Square %,% is off a %x% board',
      p_row, p_col, v_game.grid_size, v_game.grid_size;
  end if;

  v_completion := coalesce(nullif(btrim(coalesce(p_tile ->> 'rule', '')), ''),
                           'points')::tile_completion;
  v_amount := least(greatest(coalesce((nullif(btrim(p_tile ->> 'amount'), ''))::int, 1), 1), 1000);
  v_options := (
    select count(*)
      from jsonb_array_elements(
             case when jsonb_typeof(p_tile -> 'options') = 'array'
                  then p_tile -> 'options' else '[]'::jsonb end) o
     where btrim(coalesce(o ->> 'label', '')) <> ''
  );
  perform assert_tile_rule_ok(v_completion, v_options, 'This tile');
  perform assert_points_cap_reachable(v_completion, v_amount,
                                      p_tile -> 'options', 'This tile');

  v_library := nullif(btrim(coalesce(p_tile ->> 'libraryId', '')), '')::uuid;

  -- What was here before, so `times_used` counts squares filled from an entry
  -- rather than clicks. Re-saving the same square from the same entry -- which
  -- is what tweaking a target does -- must not inflate the count.
  select library_id into v_was
    from tiles where game_id = p_game_id and "row" = p_row and col = p_col;

  insert into tiles (game_id, row, col, name, icon, required_evidence,
                     description, completion, per_set, library_id)
  values (
    p_game_id, p_row, p_col,
    coalesce(nullif(btrim(p_tile ->> 'name'), ''), 'Tile'),
    nullif(regexp_replace(btrim(coalesce(p_tile ->> 'icon', '')),
                          '[^A-Za-z0-9_-]', '', 'g'), ''),
    v_amount,
    nullif(left(btrim(coalesce(p_tile ->> 'description', '')), 500), ''),
    v_completion,
    least(greatest(coalesce((nullif(btrim(p_tile ->> 'perSet'), ''))::smallint, 1), 1), 30),
    v_library
  )
  on conflict (game_id, "row", col) do update set
    name              = excluded.name,
    icon              = excluded.icon,
    required_evidence = excluded.required_evidence,
    description       = excluded.description,
    completion        = excluded.completion,
    per_set           = excluded.per_set,
    library_id        = excluded.library_id
  returning id into v_tile_id;

  -- Replaced wholesale rather than diffed: the payload is the whole tile, and
  -- a partial update would leave drops behind from whatever was here before.
  -- Safe precisely because the square above is guaranteed unclaimed, so there
  -- is no `tile_evidence` pointing at any of these rows.
  delete from tile_options where tile_id = v_tile_id;

  insert into tile_options (tile_id, label, points, sort, grp, max_times)
  select v_tile_id,
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

  if v_library is not null and (v_was is null or v_was <> v_library) then
    update tile_library
       set times_used = times_used + 1, last_used_at = now()
     where id = v_library;
  end if;

  return v_tile_id;
end;
$$;

revoke execute on function admin_set_tile(uuid, smallint, smallint, jsonb) from public, anon;
grant  execute on function admin_set_tile(uuid, smallint, smallint, jsonb) to authenticated;

-- ============================================================
-- 2. The builder needs to know before it offers the form
-- ============================================================
-- `admin_set_tile` refusing a claimed square is the rule; a console that only
-- discovers it on save is a wasted trip and reads like a bug. `claimed` is any
-- claim, fired or active: both mean a team has seen this square, and both are
-- refused above.
--
-- Return type changes, so this is a drop rather than a replace.

drop function if exists admin_list_tiles(uuid);

create function admin_list_tiles(p_game_id uuid)
returns table (
  id uuid, "row" smallint, col smallint, "position" smallint,
  name text, icon text, required_evidence smallint, options jsonb,
  description text, completion text, per_set smallint, library_id uuid,
  claimed boolean
)
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  return query
    select t.id, t.row, t.col, t.position, t.name, t.icon,
           t.required_evidence,
           (select coalesce(jsonb_agg(jsonb_build_object(
                     'id', o.id, 'label', o.label, 'points', o.points,
                     'grp', o.grp, 'max_times', o.max_times
                   ) order by o.sort, o.label), '[]'::jsonb)
              from tile_options o where o.tile_id = t.id),
           t.description, t.completion::text, t.per_set, t.library_id,
           exists (select 1 from tile_claims c where c.tile_id = t.id)
      from tiles t where t.game_id = p_game_id order by t.position;
end;
$$;

revoke execute on function admin_list_tiles(uuid) from public, anon;
grant  execute on function admin_list_tiles(uuid) to authenticated;
