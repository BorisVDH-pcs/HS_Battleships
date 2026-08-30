# HS_Battleships

Team-vs-team Battleships with a 100-tile OSRS task grid — the web/database rebuild of
the Google Sheets + Apps Script version.

One game = **two teams**, each with a 10x10 board and a fleet of `2, 3, 3, 4, 5`.
Every player has their own login; shots are attributed to the person who fired them.

## How a turn works

1. **Unlock** — a team picks a numbered tile on the enemy grid and answers its riddle.
   Fuzzy-matched server-side; the answer never reaches the browser.
2. **Arm** — the unlocked tile occupies one of the team's two slots.
3. **Fire** — the team completes the tile's in-game task and marks it done.
   HIT/MISS resolves immediately against the opponent's hidden placement.
4. **Sink** — when every cell of a ship has been hit, it sinks. All five ships sunk ends the game.

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

Two things must stay secret from the opposing team: **tile answers** and **ship
placement**. Putting the rules in the client would make both reachable. Instead,
Row Level Security hides them and every mutation goes through an RPC that validates
server-side — so there is no request a player can craft to peek or cheat.

## Layout

```
docs/how-the-spreadsheet-worked.md   reference notes on the Sheets original
docs/architecture.md                 schema + design decisions
supabase/migrations/0001_init.sql    tables, views, RLS
supabase/migrations/0002_rpc.sql     place_fleet / unlock_tile / fire_tile
```

## Setup

```bash
npm install
```

Copy `.env.example` to `.env` and fill in your Supabase project URL and anon key,
then run the two migrations in the Supabase SQL Editor in order.
