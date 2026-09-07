-- Who locked a tile in, and when.
--
-- (No tile text in this file: this repo is public and the tile contents are
-- secret #2.)
--
-- `tile_claims` has carried `claimed_by` and `claimed_at` since 0001 — the
-- README's "shots are attributed to the person who fired them" was already
-- true of claims as well. Nothing ever showed it. So the slot cards named the
-- task, the progress and the square, and could not answer the question a team
-- of ten actually asks about them: who is on this, and are they still on it.
--
-- Three slots and ten players is a coordination problem the UI was leaving to
-- Discord. The data was here the whole time.
--
-- SAFE TO SHOW. `tiles_for_me()` joins tile_claims on
-- `c.team_id = my_team_in_game(p_game_id)`, so every claim row it can see
-- belongs to the caller's own team. This exposes a team's members to each
-- other, which is what a roster is, and nothing about the opponent: the
-- opposing team's claims are not in the join at all. The two secrets the
-- design protects — ship placement and unclaimed tile contents — are
-- untouched, and every existing redaction below is carried over verbatim.
--
-- The display name is resolved here rather than in the client because a player
-- cannot read `profiles` for arbitrary ids: this function is `security
-- definer`, the client is not.

drop function if exists tiles_for_me(uuid);

create function tiles_for_me(p_game_id uuid)
returns table (
  id uuid, game_id uuid, "row" smallint, col smallint, "position" smallint,
  revealed boolean, name text, icon text,
  required_evidence smallint, evidence_count integer,
  claim_id uuid, claim_status claim_status, claim_result shot_result,
  previewed boolean, ship_sunk boolean,
  evidence_points integer, options jsonb, description text,
  completion text, per_set smallint,
  claimed_by_name text, claimed_at timestamptz
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
    ) as ship_sunk,
    case when c.id is not null
         then (select coalesce(sum(e.points), 0) from tile_evidence e where e.claim_id = c.id)
         else 0 end::int as evidence_points,
    case when c.id is not null
         then (select coalesce(jsonb_agg(jsonb_build_object(
                        'id', o.id, 'label', o.label, 'points', o.points,
                        'grp', o.grp,
                        'taken', exists (select 1 from tile_evidence e
                                          where e.claim_id = c.id and e.option_id = o.id)
                      ) order by o.sort, o.label), '[]'::jsonb)
                 from tile_options o where o.tile_id = t.id)
         end as options,
    -- Claim-gated (0048): this is cost, not identity, so a pet jar preview
    -- does not carry it.
    case when c.id is not null then t.description end as description,
    case when c.id is not null then t.completion::text end as completion,
    case when c.id is not null then t.per_set end as per_set,
    -- Claim-gated for the same reason the rest is: a previewed-but-unclaimed
    -- tile has no claim, so there is nobody to name. `claimed_by` is nullable
    -- (on delete set null), so a player whose account is gone leaves the
    -- timestamp standing and the name null — the card handles that.
    p.display_name as claimed_by_name,
    c.claimed_at
  from tiles t
  left join tile_claims c on c.tile_id = t.id
       and c.team_id = my_team_in_game(p_game_id)
  left join profiles p on p.id = c.claimed_by
  left join pet_jar_previews pv on pv.tile_id = t.id
       and pv.team_id = my_team_in_game(p_game_id)
  where t.game_id = p_game_id
  order by t.position;
$$;

revoke execute on function tiles_for_me(uuid) from public, anon;
grant  execute on function tiles_for_me(uuid) to authenticated;
