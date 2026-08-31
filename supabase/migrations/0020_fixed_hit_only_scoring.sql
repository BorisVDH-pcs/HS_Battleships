-- Scoring is deliberately fixed: one point per hit, nothing else.
--
-- Keep the old columns and score_events table for migration compatibility and
-- historical inspection, but make them incapable of changing the scoreboard.
-- The four admin scoring RPCs are removed, so an old frontend cannot restore
-- configurable weights or create another manual adjustment.

update games
   set points_per_tile = 0,
       points_per_hit  = 1,
       points_per_sink = 0;

alter table games
  alter column points_per_tile set default 0,
  alter column points_per_hit  set default 1,
  alter column points_per_sink set default 0;

alter table games
  drop constraint if exists games_hit_only_scoring;

alter table games
  add constraint games_hit_only_scoring check (
    points_per_tile = 0 and points_per_hit = 1 and points_per_sink = 0
  );

create or replace function team_scores(p_game_id uuid)
returns table (
  game_id      uuid,
  team_id      uuid,
  team_name    text,
  tiles_fired  integer,
  hits         integer,
  misses       integer,
  active_tiles integer,
  ships_sunk   integer,
  adjustments  integer,
  total        integer
)
language sql stable security definer set search_path = public as $$
  with base as (
    select
      t.game_id as g_id,
      t.id      as t_id,
      t.name    as t_name,
      (select count(*) from tile_claims c
        where c.team_id = t.id and c.status = 'fired')::int as n_fired,
      (select count(*) from tile_claims c
        where c.team_id = t.id and c.status = 'fired' and c.result = 'hit')::int as n_hits,
      (select count(*) from tile_claims c
        where c.team_id = t.id and c.status = 'fired' and c.result = 'miss')::int as n_misses,
      (select count(*) from tile_claims c
        where c.team_id = t.id and c.status = 'active')::int as n_active,
      (select count(*) from ships s
         join teams et on et.id = s.team_id
        where et.game_id = t.game_id
          and et.id <> t.id
          and not exists (
            select 1 from ship_cells sc
             where sc.ship_id = s.id
               and not exists (
                 select 1 from tiles ti
                   join tile_claims c on c.tile_id = ti.id
                  where ti.game_id = t.game_id
                    and ti.row = sc.row and ti.col = sc.col
                    and c.team_id = t.id
                    and c.status = 'fired' and c.result = 'hit'
               )
          ))::int as n_sunk
    from teams t
    where t.game_id = p_game_id
  )
  select
    b.g_id, b.t_id, b.t_name,
    b.n_fired, b.n_hits, b.n_misses, b.n_active, b.n_sunk,
    0::integer as adjustments,
    b.n_hits as total
  from base b
  order by b.t_name;
$$;

drop function if exists admin_adjust_score(uuid, integer, text, uuid);
drop function if exists admin_delete_score_event(uuid);
drop function if exists admin_list_score_events(uuid);
drop function if exists admin_set_scoring(uuid, smallint, smallint, smallint);
