-- HS_Battleships — initial schema
-- Run in the Supabase SQL Editor (or via `supabase db push`).
--
-- Design rules (see docs/architecture.md):
--   1. Two secrets must NEVER reach a client: tile answers, and the enemy's ship
--      placement. Both are protected by RLS; all writes go through `security definer`
--      RPCs that check the answer / resolve the shot server-side.
--   2. Ship-sunk status is DERIVED (see view `ship_status`), never stored. The
--      spreadsheet's snapshot-diff hack is what we are deliberately replacing.
--   3. A shot IS a completed tile claim. There is no separate "shots" table —
--      in this game you fire by completing the tile task, exactly as in Sheets.

create extension if not exists "pgcrypto";
create extension if not exists "fuzzystrmatch";   -- levenshtein() for answer matching

-- ============================================================
-- Identity
-- ============================================================

-- One row per authenticated user. `id` mirrors auth.users.id.
create table if not exists profiles (
  id           uuid        primary key references auth.users(id) on delete cascade,
  display_name text        not null,
  rsn          text,                            -- RuneScape name, for the Discord feed
  created_at   timestamptz not null default now()
);

-- ============================================================
-- Game / teams
-- ============================================================

create type game_status as enum ('setup', 'placement', 'active', 'finished');

create table if not exists games (
  id               uuid        primary key default gen_random_uuid(),
  name             text        not null,
  status           game_status not null default 'setup',
  grid_size        smallint    not null default 10 check (grid_size between 5 and 26),
  max_armed_tiles  smallint    not null default 2 check (max_armed_tiles >= 1),
  fleet            smallint[]  not null default '{2,3,3,4,5}',
  winner_team_id   uuid,                        -- FK added after teams exists
  started_at       timestamptz,
  ended_at         timestamptz,
  created_at       timestamptz not null default now()
);

-- Exactly two teams per game (enforced by trigger below).
create table if not exists teams (
  id                   uuid        primary key default gen_random_uuid(),
  game_id              uuid        not null references games(id) on delete cascade,
  name                 text        not null,
  discord_role_id      text,                    -- for @role pings in the feed
  created_at           timestamptz not null default now(),
  unique (game_id, name)
);

alter table games
  add constraint games_winner_team_fk
  foreign key (winner_team_id) references teams(id) on delete set null;

create or replace function enforce_two_teams() returns trigger
language plpgsql as $$
begin
  if (select count(*) from teams where game_id = new.game_id) >= 2 then
    raise exception 'Game % already has two teams', new.game_id;
  end if;
  return new;
end;
$$;

create trigger teams_max_two
  before insert on teams
  for each row execute function enforce_two_teams();

create type team_role as enum ('captain', 'member');

create table if not exists team_members (
  team_id    uuid        not null references teams(id) on delete cascade,
  profile_id uuid        not null references profiles(id) on delete cascade,
  role       team_role   not null default 'member',
  joined_at  timestamptz not null default now(),
  primary key (team_id, profile_id)
);

-- ============================================================
-- Tiles — the 100-tile task grid, shared by both teams
-- ============================================================
-- Both teams see the same task at the same coordinate; each team unlocks and
-- fires them independently against the opponent's board.

create table if not exists tiles (
  id              uuid     primary key default gen_random_uuid(),
  game_id         uuid     not null references games(id) on delete cascade,
  row             smallint not null check (row >= 1),
  col             smallint not null check (col >= 1),
  -- Tile number 1..100, numbered left-to-right, top-to-bottom, as in the sheet.
  position        smallint generated always as ((row - 1) * 10 + col) stored,
  name            text     not null,            -- e.g. 'A1. Slayer tile'
  question        text     not null,            -- the unlock riddle
  answer_variants text[]   not null,            -- accepted answers (was '/'-separated)
  rules           text,
  unique (game_id, row, col)
);

-- ============================================================
-- Ships — each team's own placement (SECRET from the opponent)
-- ============================================================

create table if not exists ships (
  id      uuid     primary key default gen_random_uuid(),
  team_id uuid     not null references teams(id) on delete cascade,
  size    smallint not null check (size between 1 and 10)
);

create table if not exists ship_cells (
  ship_id uuid     not null references ships(id) on delete cascade,
  team_id uuid     not null references teams(id) on delete cascade,  -- denormalised for the
  row     smallint not null,                                        -- one-ship-per-cell rule
  col     smallint not null,
  primary key (ship_id, row, col),
  unique (team_id, row, col)      -- a team's ships may never overlap
);

-- ============================================================
-- Tile claims — unlock (armed) then fire
-- ============================================================

create type claim_status as enum ('armed', 'fired');
create type shot_result  as enum ('hit', 'miss');

create table if not exists tile_claims (
  id           uuid         primary key default gen_random_uuid(),
  team_id      uuid         not null references teams(id) on delete cascade,
  tile_id      uuid         not null references tiles(id) on delete cascade,
  status       claim_status not null default 'armed',
  unlocked_by  uuid         references profiles(id) on delete set null,
  unlocked_at  timestamptz  not null default now(),
  fired_by     uuid         references profiles(id) on delete set null,
  fired_at     timestamptz,
  result       shot_result,
  unique (team_id, tile_id),      -- a team claims a given tile at most once
  constraint fired_rows_complete check (
    (status = 'armed' and result is null and fired_at is null) or
    (status = 'fired' and result is not null and fired_at is not null)
  )
);

-- The two-slot rule from the sheet (L6 / N6), enforced properly.
create or replace function enforce_armed_limit() returns trigger
language plpgsql as $$
declare
  limit_n smallint;
  armed_n smallint;
begin
  select g.max_armed_tiles into limit_n
    from games g join teams t on t.game_id = g.id
   where t.id = new.team_id;

  select count(*) into armed_n
    from tile_claims
   where team_id = new.team_id and status = 'armed' and id <> new.id;

  if armed_n >= limit_n then
    raise exception 'Team % already has % armed tiles — finish those first',
      new.team_id, limit_n;
  end if;
  return new;
end;
$$;

create trigger tile_claims_armed_limit
  before insert on tile_claims
  for each row when (new.status = 'armed')
  execute function enforce_armed_limit();

-- ============================================================
-- Derived ship status — replaces the snapshot-diff hack
-- ============================================================
-- A ship is sunk when every one of its cells has been hit by the OTHER team.

create or replace view ship_status as
select
  s.id                                          as ship_id,
  s.team_id,
  t.game_id,
  s.size,
  count(tc.id)                                  as hits,
  count(tc.id) = s.size                         as sunk
from ships s
join teams  t  on t.id = s.team_id
join ship_cells sc on sc.ship_id = s.id
left join tiles ti
       on ti.game_id = t.game_id
      and ti.row = sc.row
      and ti.col = sc.col
left join tile_claims tc
       on tc.tile_id = ti.id
      and tc.status  = 'fired'
      and tc.result  = 'hit'
      and tc.team_id <> s.team_id     -- only the opponent's shots count
group by s.id, s.team_id, t.game_id, s.size;

-- ============================================================
-- Scoring & event feed
-- ============================================================

-- Most scoring is derived from tile_claims; this table exists for manual
-- adjustments (the sheet's "+1" button) and keeps an audit trail.
create table if not exists score_events (
  id            uuid        primary key default gen_random_uuid(),
  team_id       uuid        not null references teams(id) on delete cascade,
  profile_id    uuid        references profiles(id) on delete set null,
  delta         integer     not null,
  reason        text        not null,
  tile_claim_id uuid        references tile_claims(id) on delete set null,
  created_at    timestamptz not null default now()
);

create type event_type as enum (
  'tile_unlocked', 'shot_fired', 'ship_sunk', 'game_started', 'game_won'
);

-- Append-only feed. Drives both the in-app activity log (via Realtime) and
-- the Discord relay, so notifications are never lost on a failed webhook.
create table if not exists game_events (
  id         uuid        primary key default gen_random_uuid(),
  game_id    uuid        not null references games(id) on delete cascade,
  team_id    uuid        references teams(id) on delete set null,
  type       event_type  not null,
  payload    jsonb       not null default '{}'::jsonb,
  relayed_at timestamptz,                     -- set once pushed to Discord
  created_at timestamptz not null default now()
);

create index if not exists idx_teams_game          on teams(game_id);
create index if not exists idx_tiles_game          on tiles(game_id);
create index if not exists idx_ship_cells_team     on ship_cells(team_id);
create index if not exists idx_claims_team         on tile_claims(team_id);
create index if not exists idx_claims_tile         on tile_claims(tile_id);
create index if not exists idx_events_game         on game_events(game_id, created_at desc);
create index if not exists idx_events_unrelayed    on game_events(created_at) where relayed_at is null;

-- ============================================================
-- Helpers
-- ============================================================

create or replace function my_team_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select team_id from team_members where profile_id = auth.uid();
$$;

-- ============================================================
-- Row Level Security
-- ============================================================

alter table profiles      enable row level security;
alter table games         enable row level security;
alter table teams         enable row level security;
alter table team_members  enable row level security;
alter table tiles         enable row level security;
alter table ships         enable row level security;
alter table ship_cells    enable row level security;
alter table tile_claims   enable row level security;
alter table score_events  enable row level security;
alter table game_events   enable row level security;

create policy profiles_read   on profiles     for select using (true);
create policy profiles_self   on profiles     for update using (id = auth.uid());
create policy games_read      on games        for select using (true);
create policy teams_read      on teams        for select using (true);
create policy members_read    on team_members for select using (true);
create policy claims_read     on tile_claims  for select using (true);
create policy scores_read     on score_events for select using (true);
create policy events_read     on game_events  for select using (true);

-- SECRET #1 — a team may only ever see its OWN ships.
create policy ships_own_team on ships
  for select using (team_id in (select my_team_ids()));

create policy ship_cells_own_team on ship_cells
  for select using (team_id in (select my_team_ids()));

-- SECRET #2 — tile answers. `answer_variants` is stripped from the client-facing
-- view below; the base table is readable only by the service role.
create policy tiles_no_direct_read on tiles for select using (false);

create or replace view tiles_public
with (security_invoker = false) as
  select id, game_id, row, col, position, name, question, rules
    from tiles;

grant select on tiles_public to authenticated, anon;

-- No client-side INSERT/UPDATE/DELETE policies anywhere: every mutation goes
-- through the `security definer` RPCs in 0002_rpc.sql.
