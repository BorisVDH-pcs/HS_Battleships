# HS_Battleships

Team-vs-team Battleships with a 100-tile OSRS task grid — the web/database rebuild of
the Google Sheets + Apps Script version.

One game = **two teams**, each with a 10x10 board and a fleet of `2, 3, 3, 4, 5`.
Every player has their own login; shots are attributed to the person who fired them.

## How a move works

There is **no turn order**. A team plays whenever it has a free slot.

1. **Claim** — a team picks a numbered tile on the enemy grid. Picking is the move;
   there is no question to answer. The task is revealed to that team only.
2. **Active** — the claimed tile occupies one of the team's **two** slots.
   No third tile can be claimed until one is fired.
3. **Fire** — the team completes the tile's in-game task and marks it done.
   HIT/MISS resolves immediately against the opponent's hidden placement,
   and the slot frees up for the next claim.
4. **Sink** — when every cell of a ship has been hit, it sinks. All five ships sunk ends the game.

Fleets are placed before the game starts and **frozen the moment it does** — for
players, captains and admins alike.

## Stack

| Layer | Choice |
|---|---|
| Database | Supabase (Postgres) — schema in `supabase/migrations/` |
| Game logic | Postgres `security definer` functions (`0002_rpc.sql`) |
| Live updates | Supabase Realtime on `game_events` |
| Frontend | Vite + React |
| Notifications | Discord relay driven off the `game_events` feed |
| Hosting | Netlify / Vercel |

## Why the logic lives in the database

Two things must stay secret from the opposing team: **ship placement** and the
**contents of tiles they have not claimed** (teams pick blind). Putting the rules in
the client would make both reachable. Instead, Row Level Security hides them and
every mutation goes through an RPC that validates server-side — so there is no
request a player can craft to peek or cheat.

## Layout

```
docs/how-the-spreadsheet-worked.md   reference notes on the Sheets original
docs/architecture.md                 schema + design decisions
supabase/migrations/0001_init.sql    tables, views, RLS
supabase/migrations/0002_rpc.sql     place_fleet / start_game / claim_tile / fire_tile
```

## Layout (frontend)

```
web/src/lib/supabase.js       client + the four game RPCs
web/src/lib/board.js          coordinate helpers (A1..J10 <-> row/col <-> 1..100)
web/src/hooks/useGame.js      loads game state, refetches on Realtime events
web/src/components/           EnemyGrid, MyFleet, ActiveTiles, EventFeed, Login
```

## Setup

The migrations in `supabase/migrations/` are already applied to the **Battleships**
Supabase project. For a fresh project, run them in order in the SQL Editor.

```bash
npm install --prefix web
```

Copy `.env.example` to `web/.env` and set `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY`, then:

```bash
npm run dev --prefix web
```

The dev server runs on **port 5174**, so it can sit alongside HighSocietyScape on 5173.

### Demo data

A "Demo Match" game exists in the Battleships project with both fleets placed,
100 placeholder tiles, and a throwaway `demo@hsbattleships.local` account for
clicking around. Delete both before running a real event.

Credentials are deliberately not recorded here — keep them out of the repo.
