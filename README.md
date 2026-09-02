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

Scoring is fixed: **each hit is one point**. Completed tiles, missed shots,
sunken ships and manual adjustments do not add points.

Fleets are placed before the game starts and **frozen the moment it does** — for
players, captains and admins alike. **Ships may not touch, not even at the
corners**, so every ship is surrounded by at least one clear cell.

## Running an event (admin)

Admins get an **Admin** tab in the app. Everything below is also enforced
server-side, so the tab is a convenience, not the permission:

1. **New game** — name it and name both teams.
2. **Tiles** — paste 100 lines, one per tile in board order, optionally
   `name | icon`. This replaces the Middleman sheet's `Tile Data`.
3. **Team names** — rename either team whenever needed.
4. **Open placement** — moves the game from `setup` to `placement`.
5. **Roster** — add players to teams and pick captains. Players appear here
   once they have signed up on the login screen.
6. **Fleets** — captains place their own fleets from the player page. The admin
   page shows both boards as a read-only live overview.
7. **Start game** — refuses unless there are two teams, 100 tiles and both
   fleets complete. Fleets freeze at this moment.

Captains also get a **Your team** card on their player page where they can
rename their own team. The database refuses cross-team renames.

Grant admin with `update profiles set is_admin = true where display_name = '…';`

## Stack

| Layer | Choice |
|---|---|
| Database | Supabase (Postgres) — schema in `supabase/migrations/` |
| Game logic | Postgres `security definer` functions (`0002_rpc.sql`) |
| Live updates | Supabase Realtime on `game_events` |
| Frontend | Vite + React |
| Notifications | Discord relay driven off the `game_events` feed |
| Hosting | GitHub Pages, built by `.github/workflows/deploy.yml` |

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

## Deploying

Every push to `main` builds the site and publishes it to
**https://borisvdh-pcs.github.io/HS_Battleships/**.

The Supabase project URL and anon key live in `web/.env.production`, committed on
purpose: Vite inlines them into the bundle, so they are public the moment the site
is served either way. RLS and the security-definer RPCs are what protect the data —
not the secrecy of the anon key. Repo secrets named `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` override the file if you ever want to rotate the key
without a commit, but none are needed for a working deploy.

> **One-time setting:** GitHub → Settings → Pages → Source must be **"GitHub
> Actions"**, not "Deploy from a branch" — `dist/` is gitignored, so branch mode
> would serve the README instead of the app.

## TODO

- **CI for the backend.** `deploy.yml` only builds and publishes `web/` — a new
  file in `supabase/migrations/` still has to be applied by hand in the SQL
  Editor (see Setup). Add a workflow that runs `supabase db push` (Supabase
  CLI, linked via `SUPABASE_ACCESS_TOKEN` + `SUPABASE_DB_PASSWORD` repo
  secrets) whenever a push to `main` touches `supabase/migrations/**`, so a
  merged migration reaches the live project without a manual step. Needs care:
  unlike the frontend build, a bad migration mutates production data, so this
  should probably run migrations only (never `db reset`), and might warrant a
  dry-run/diff check or a required review before the push step runs.

- **Paste-to-target evidence upload.** Clicking an active tile's evidence slot
  should highlight it as the paste target, so a `Ctrl+V` of a copied
  screenshot uploads straight into that slot instead of requiring the file
  picker. Touches `ActiveTiles.jsx` / `EvidenceUploader.jsx` — needs a
  "selected slot" bit of state and a `paste` listener that reads
  `clipboardData.files`/`items`.

- **Discord ping on evidence submission.** *(Checked: does not exist yet.)*
  `add_evidence()` (0023) never writes to `game_events`, and `discord_line()`
  (0032) has no case for it — only `fleet_placed`, `game_started`,
  `team_renamed`, `tile_claimed`, `claim_released`, `shot_fired`, `ship_sunk`,
  `game_won`, `game_reset`, `score_adjusted` are handled. Want: on each
  submission, notify with something like *"`<player>` submitted proof for
  `<tile_name>` (`<evidence_count>`/`<required_evidence>`) — `<n>` tile(s) left
  to fire"*, and a distinct message once the last slot opens up ("a slot is
  free to claim"). Two things to design around:
  - This has to go to the **team's own** channel, not the shared/general one
    `shot_fired` etc. use — `discord_webhooks` currently only keys webhooks by
    `game_id` (or global), not by team, so it needs a `team_id` column (or a
    second table) plus a lookup change in `relay_pending()`.
  - Naming the tile is only safe in that team-private channel — never in
    anything the opposing team could read. `discord_line()`'s payload-only
    rule exists specifically so the general relay can't leak secret #2 (see
    architecture.md); a team-scoped message is exempt only because the team
    already knows its own claimed tile's name.

- **Layout: score + active tiles on the right, board centered.** Currently
  `Scoreboard` and `ActiveTiles` stack full-width above the board in
  `App.jsx`'s `.boards` section. Move them into a right-hand panel alongside
  the board, keeping their existing card styling/pattern, so the grid reads as
  the visual center of the page.

- **Center the tile-color legend under the board, not the activity feed.**
  `BoardLegend` should stay aligned under `EnemyGrid`/`MyFleet` once the
  activity feed moves beside the board (see next item), not span whatever is
  next to it.

- **Move the activity feed to the left of the board, and cap its height.**
  `EventFeed` currently renders every loaded event as one long list below
  everything else. Move it to a left-hand column next to the board, show a
  limited number of rows, and make the rest reachable by scrolling inside the
  panel (`max-height` + `overflow-y: auto`) rather than growing the page.

- **Statistics panel on the right side.** A per-game/per-player stats card
  (shots fired, hits, accuracy, tiles claimed, ships sunk, etc. — see
  `game_events` and `tile_claims.claimed_by`/`fired_by` for the raw per-player
  data) alongside the `Scoreboard`/`ActiveTiles` right-hand panel above. Make
  the set of stats shown configurable — a settings toggle to pick which rows
  appear, rather than a fixed list — since not every stat is meaningful (or
  wanted) for every event.
  - `useGame.js`'s `game_events` query is capped at `limit(50)` and every
    Realtime insert re-triggers the whole `load()` (see comment at
    `useGame.js:114-126`); full-game stats need the complete event history,
    not the last 50 rows, so this needs its own fetch, separate from the
    board-state one.
    Be a good citizen about it: derive the stats query/computation once and
    cache the result (e.g. `useMemo` keyed on game id + latest event id, or a
    module-level cache), and only recompute/refetch on an actual new event —
    not on every render or every unrelated Realtime tick.

## Sign-in: username only, no email

Players sign in with a **username and password**. There is no email anywhere in
the flow. Supabase Auth keys on email, so the username is mapped to a synthetic
address at `@players.hs-battleships.invalid` that players never see or type
(`web/src/lib/auth.js`). `.invalid` is IANA-reserved, so no mail can ever reach a
real domain.

The trade-off, accepted deliberately: **there is no self-service password reset**,
because there is no mailbox to send a link to. An admin resets passwords — see
`supabase/admin/player-accounts.sql`, which also covers creating accounts and
putting players on teams.

> **Required setting:** turn **off** Authentication → Sign In / Providers → Email →
> "Confirm email" in the Supabase dashboard. Otherwise Supabase tries to send a
> confirmation to an address that cannot receive one, and sign-ups fail with
> `email rate limit exceeded`. Accounts created through the admin SQL work either
> way, since they set `email_confirmed_at` directly.

### Demo data

A "Demo Match" game exists in the Battleships project with both fleets placed,
100 placeholder tiles, and a throwaway `demo@hsbattleships.local` account for
clicking around. Delete both before running a real event.

Credentials are deliberately not recorded here — keep them out of the repo.
