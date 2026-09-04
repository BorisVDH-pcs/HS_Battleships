-- Which side of the board a team sits on.
--
-- The admin console draws two boards side by side and the organiser reasonably
-- expects "team one" — the first name typed into New game — always on the left.
-- Nothing in the schema could answer that:
--
--   * created_at is useless here. admin_create_game inserts both teams in a
--     single statement, and now() is the transaction timestamp, so the two rows
--     share one value to the microsecond. Ordering by it is ordering by a tie,
--     and the tiebreak is physical row order — stable until the day a row is
--     updated, then silently not.
--   * id is a random uuid and carries no order at all.
--   * name is alphabetical, which is a different question, and moves when a
--     captain renames their team.
--
-- So the creation slot gets recorded explicitly. 1 is the left board, 2 is the
-- right, and neither moves for a rename.
--
-- Existing games cannot be backfilled correctly, because the information was
-- never written down: both rows are indistinguishable. They are assigned by
-- name, which is where they already sit today, so nothing visibly moves.

alter table teams add column if not exists slot smallint;

-- Backfill before the constraints go on, or the NOT NULL below fails.
with ranked as (
  select id, row_number() over (partition by game_id order by name) as rn
  from teams
)
update teams t
set    slot = ranked.rn
from   ranked
where  ranked.id = t.id
  and  t.slot is null;

alter table teams alter column slot set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'teams_slot_check') then
    alter table teams add constraint teams_slot_check check (slot in (1, 2));
  end if;
  -- One left and one right per game. This is also what stops a future bug from
  -- quietly putting both teams on the same side.
  if not exists (select 1 from pg_constraint where conname = 'teams_game_slot_key') then
    alter table teams add constraint teams_game_slot_key unique (game_id, slot);
  end if;
end $$;

-- Unchanged from 0031 apart from the two slot values on the insert.
create or replace function admin_create_game(
  p_name text, p_team_a text, p_team_b text,
  p_grid_size smallint default 10, p_max_active smallint default 3
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_game_id uuid;
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if btrim(coalesce(p_name,''))   = '' then raise exception 'Game needs a name'; end if;
  if btrim(coalesce(p_team_a,'')) = '' or btrim(coalesce(p_team_b,'')) = '' then
    raise exception 'Both teams need a name';
  end if;
  if btrim(p_team_a) = btrim(p_team_b) then
    raise exception 'The two teams need different names';
  end if;

  insert into games (name, status, grid_size, max_active_tiles)
  values (btrim(p_name), 'setup', p_grid_size, p_max_active)
  returning id into v_game_id;

  -- p_team_a is team one and takes the left board; p_team_b is team two.
  insert into teams (game_id, name, slot)
  values (v_game_id, btrim(p_team_a), 1), (v_game_id, btrim(p_team_b), 2);

  return v_game_id;
end;
$$;
