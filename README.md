# Contributors

- [iftach21](https://github.com/iftach21)
- [BorisVDH-PCS](https://github.com/BorisVDH-pcs)

# HS Battleships

HS Battleships is a browser-based team event that combines the strategy of
Battleships with collaborative Old School RuneScape challenges. Multiple matches
can be managed independently, with each match containing two teams and a concealed
game board.

## Game overview

Each team secretly places a fleet on its own grid. Players select concealed
positions on the opposing board, complete the associated in-game objective, and
submit evidence to fire at that position.

## Rules and mechanics

- There is no fixed turn order; teams can act whenever they have an available task
  slot.
- Objectives remain concealed until a position is claimed or previewed through an
  earned game mechanic.
- A team can work on only a limited number of claimed objectives at once.
- Completing an objective and submitting the required evidence resolves the shot
  as a hit or miss.
- Ships cannot touch, including diagonally, and their positions are locked when the
  match begins.
- A ship sinks when all of its occupied positions have been hit.
- The first team to sink the opposing fleet wins.
- Match activity and team statistics update live for the players.

The application also provides tools for organisers to configure matches, manage
teams and players, review evidence, and monitor progress.

## Stack

| Layer | Choice |
|---|---|
| Database | Supabase (Postgres) — schema in `supabase/migrations/` |
| Game logic | Postgres `security definer` functions, one migration per change |
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

## Where things are

```
docs/handover.md                  pick-it-up-cold notes; session log at the bottom
docs/v4-handover.md               tile completion rules and the V4 board
docs/architecture.md              schema + design decisions
docs/how-the-spreadsheet-worked.md  reference notes on the Sheets original
docs/website-review.md            the 2026-09-07 UI review and its triage
supabase/migrations/              one file per change, applied in filename order
supabase/admin/                   runbook SQL (player accounts, password resets)
```

Migrations are numbered `0001…0032` and then by timestamp. They are **not** a
short list any more — `ls` the directory rather than trusting a table in a doc.

```
web/src/lib/supabase.js       client + the game RPCs
web/src/lib/board.js          coordinate helpers (A1..J10 <-> row/col <-> 1..100)
web/src/lib/tileProgress.js   how far a claimed tile is, per completion rule
web/src/lib/tileDraft.js      a tile in its three shapes: row, form draft, payload
web/src/lib/icons.js          GENERATED — `npm run icons:manifest`, never by hand
web/src/hooks/useGame.js      loads game state, refetches on Realtime events
web/src/components/           EnemyGrid, MyFleet, ActiveTiles, EventFeed, Login,
                              BoardBuilder, TileForm, TileInfo, EvidenceUploader
```

## How a tile is finished

Each tile carries a **completion rule** deciding when its evidence is enough.
`claim_is_complete()` in the database is the only authority; `tileProgress.js`
mirrors it so the interface can predict the same answer.

| rule | finishes when |
|---|---|
| `points` | option points reach the target; repeats count |
| `one_set` | any one group is fully collected |
| `each_set` | every group has N **distinct** options |
| `points_per_set` | every group has N points; **repeats count** |
| `value` | the submitter types what each drop was worth, and the total reaches the target |

Boards are assembled in the **board builder** against a reusable tile catalogue.
Details, and the `each_set` / `points_per_set` distinction that is easy to get
wrong, are in [docs/v4-handover.md](docs/v4-handover.md).

## Tests

```bash
npm run test:tile-rules --prefix web
npm run test:tile-draft --prefix web
```

Nothing runs these in CI. Run both before committing anything that touches tile
rules — they have been broken by an unrelated deletion before, and a `SyntaxError`
does not look like a failing assertion.

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

