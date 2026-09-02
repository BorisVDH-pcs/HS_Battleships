-- Tell a shooter when a hit they dealt finished off the whole ship, not just
-- the square, so the enemy grid can go dark on that tile the same way
-- MyFleet already does for a team's own hulls.
--
-- This is not new information leaking early: `tiles_for_me` already tells a
-- team a tile is a hit the moment they fire it, so checking whether every
-- *other* cell of that same hull is also a hit-by-this-team reveals nothing
-- about any square this team has not already fired on. The ship's identity
-- and its other cells' coordinates are never returned, only a boolean.
--
-- `ship_cells` has no game_id, so the sibling-cell lookup is scoped through
-- `teams` to the game at hand and restricted to a team other than the
-- shooter's own -- otherwise a coincidental (row, col) match against some
-- other game's fleet, or the shooter's own fleet, could mismatch the hull.

drop function if exists tiles_for_me(uuid);

create function tiles_for_me(p_game_id uuid)
returns table (
  id uuid, game_id uuid, "row" smallint, col smallint, "position" smallint,
  revealed boolean, name text, icon text,
  required_evidence smallint, evidence_count integer, early_complete boolean,
  claim_id uuid, claim_status claim_status, claim_result shot_result,
  previewed boolean, ship_sunk boolean
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
    (pv.id is not null) as previewed,
    coalesce(
      c.result = 'hit' and not exists (
        select 1
          from ship_cells hull
         where hull.ship_id = (
                 select sc.ship_id
                   from ship_cells sc
                   join teams te on te.id = sc.team_id
                  where te.game_id = t.game_id
                    and te.id <> c.team_id
                    and sc.row = t.row and sc.col = t.col
                  limit 1
               )
           and not exists (
                 select 1
                   from tiles ti2
                   join tile_claims tc2 on tc2.tile_id = ti2.id
                  where ti2.game_id = t.game_id
                    and ti2.row = hull.row and ti2.col = hull.col
                    and tc2.team_id = c.team_id
                    and tc2.status = 'fired'
                    and tc2.result = 'hit'
               )
      ),
      false
    ) as ship_sunk
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
