# Handover — HS_Battleships

Current as of **2026-08-30**, end of session. Written to be picked up cold, by
Boris or by another session with no memory of this one.

---

## What this is

An OSRS clan Battleships game, rebuilt from three Google Sheets + Apps Script
into a database-backed web app. Two teams, one shared 100-tile task grid, each
team hiding a fleet of `2,3,3,4,5` on its own 10x10 board.

| | |
|---|---|
| Repo | https://github.com/BorisVDH-pcs/HS_Battleships |
| Live | https://borisvdh-pcs.github.io/HS_Battleships/ |
| Supabase | project `Battleships` — `fjgcijmdxeebgkdokini`, eu-west-2 |
| Local | No canonical path — clone it where you need it. On Boris's work laptop: `Desktop/BorisHS/HS_Battleships` |
| Dev server | port **5174** (`npm run dev --prefix web`) |

The Supabase project is deliberately **separate** from HighSocietyScape's
`PProject`, which has colliding `teams` / `team_members` tables. The dev port is
5174 for the same reason — HighSocietyScape owns 5173.

Background on the original spreadsheet is in
[how-the-spreadsheet-worked.md](how-the-spreadsheet-worked.md); design rationale
in [architecture.md](architecture.md).

---

## The rules (V4)

Changed from the spreadsheet version on Boris's instruction:

| Rule | Detail |
|---|---|
| No turn order | A team fires again the moment it completes a tile |
| No unlock questions | Picking a tile **is** the move; Levenshtein answer-matching is gone |
| Two active tiles max | Per team, enforced by trigger (`enforce_active_limit`) |
| Fleets frozen at start | Players, captains and admins alike, enforced by table trigger |
| Ships may not touch | Not even diagonally — every ship has a clear cell around it |

---

## Architecture in one paragraph

**Two things must never reach the opposing team: enemy ship placement, and the
contents of tiles that team has not claimed.** Both are enforced by Row Level
Security, not by the UI. Clients have no INSERT/UPDATE/DELETE rights anywhere;
every mutation goes through a `security definer` RPC that validates server-side.
The `tiles` table denies all direct reads — the app reads the `tiles_for_me`
view, which nulls out unclaimed tiles. The `game_events` feed is world-readable
and therefore **must never carry a tile's name or rules**: the grid is shared, so
naming a tile would reveal it on the reader's own board. (The original Apps
Script author had the same rule — the public webhook omitted tile names.)

### Migrations — all applied to the live project

| File | What it does |
|---|---|
| `0001_init.sql` | Tables, enums, RLS, `tiles_for_me`, `ship_status`, freeze + active-limit triggers |
| `0002_rpc.sql` | `place_fleet`, `start_game`, `claim_tile`, `fire_tile` |
| `0003_harden.sql` | Revokes `anon` EXECUTE; `ship_status` to security_invoker |
| `0004_profile_on_signup.sql` | `handle_new_user()` trigger creating `profiles` from auth metadata |
| `0005_lock_down_trigger_function.sql` | Revokes EXECUTE on that trigger function — it was callable as an RPC |
| `0006_admin_and_ship_spacing.sql` | Admin role + admin RPCs, ship-spacing rule, `start_game` made admin-only |
| `0007_enable_realtime.sql` | Publishes `game_events` — **Realtime did nothing before this** |
| `0008_score_event_type.sql` | Adds the `score_adjusted` event type (separate file so it commits before 0009 uses it) |
| `0009_scoring.sql` | Scoring weights on `games`, the `team_scores` view, the four score RPCs, and `score_events` taken off world-read |

The Supabase migration ledger lists one fewer than there are files:
`0005_lock_down_trigger_function` was applied as a plain statement rather than
through `apply_migration`, so it does not appear in `list_migrations`. The revoke
itself **is** live — `handle_new_user` has no `anon`/`authenticated` EXECUTE.
Bookkeeping only, but it makes the ledger a bad way to check what is applied.

---

## Auth — the unusual part

**Username + password only. No email anywhere.** Supabase Auth keys on email, so
each username maps to a synthetic address:

```
"Lil Sod"  ->  lil_sod@players.hs-battleships.invalid
```

`.invalid` is IANA-reserved so nothing can ever be delivered. Supabase rejects
`.local` as malformed; `.invalid` passes. The mapping lives in
`web/src/lib/auth.js` and is duplicated in the admin SQL — **change one, change
both.**

Consequence Boris accepted explicitly: **there is no self-service password
reset.** He resets them by SQL (`supabase/admin/player-accounts.sql`).

**"Confirm email" is OFF** in Supabase — verified, because `Soft Papi` signed up
through the live site and came back with `email_confirmed_at` set. Self-signup
works. Do not turn it back on.

### Admin is a separate account, never a flag on a player

An admin can read every tile's task and both fleets. An account that both ran the
event and played in it could see its own team's answers. So:

- `profiles.is_admin`, granted only by SQL; the `profiles_self` policy blocks
  self-promotion
- admin accounts are hidden from the roster picker
- admins get the console only, never the player board

### Accounts as they stand

| Username | Role | Notes |
|---|---|---|
| `hs_admin` (HS Admin) | **admin** | Boris holds the password; not recorded anywhere, including here |
| `demo` | captain, Kriegsmarine | throwaway |
| `Lil Sod` | captain, Flikkerlikkers | throwaway |
| `Soft Papi` | member, Kriegsmarine | created by Boris to test signup; assigned during testing |

All four are test accounts except `hs_admin`. Delete the demo data before a real
event — see gaps below.

---

## Running an event

All in the app, signed in as the admin:

1. **New game** — name it and both teams
2. **Tiles** — paste 100 lines in board order, `name | rules` optional
3. **Open placement**
4. **Roster** — add players, set captains (players must have signed up first)
5. **Fleets** — click a hull, click its top-left cell, `R` rotates
6. **Start game** — refuses without 2 teams, 100 tiles and 2 complete fleets
7. **Score** — set what a tile, a hit and a sinking are worth (defaults: 1, 0, 0),
   and award or dock points by hand with a reason. Every adjustment can be undone

Once active, the Fleets card becomes a live spectator view: one board per team,
its ships plus incoming shots, with sunk/hit counts, updating over Realtime.

### What players see

- **Signed up, no team yet:** "You are not assigned to a team yet. Come back once
  teams have been made." No board. The page polls every 10s and admits them by
  itself once assigned — roster changes emit no `game_event`, so Realtime cannot
  carry this.
- **On a team:** enemy waters (claimable), their own fleet with incoming shots,
  their active tile slots, and the event feed.

---

## Deployment

Push to `main` → GitHub Actions builds → Pages. Source is set to **"GitHub
Actions"**.

**No repo secrets are needed.** The Supabase URL and publishable key live in
`web/.env.production`, committed on purpose: Vite inlines every `VITE_*` var into
the public bundle, so they are public the moment the site is served regardless.
RLS is what protects the data.

> **Never put an `sb_secret_` key in that file or in a repo secret.** This
> happened once: a secret key pasted into the `VITE_SUPABASE_ANON_KEY` repo
> secret overrode the committed key and was published in the bundle. It was
> rotated, and the workflow now fails the build on `sb_secret_*` and
> `service_role` JWTs. Secrets of the same name still override the file, which is
> the rotation path.

**Deploys are not instant.** Twice this session a fix looked broken because the
old bundle was still live or cached. Check what is actually deployed before
debugging:

```bash
curl -s https://borisvdh-pcs.github.io/HS_Battleships/ | grep -o 'index-[^"]*\.js'
```

Then hard-refresh (Ctrl+F5) — the browser caches the previous bundle.

---

## Known gaps / next steps

Roughly in priority order:

1. **Real tile content.** The 100 tiles from the Middleman sheet's `Tile Data`
   have never been imported. The admin paste box takes them directly.
2. **Discord relay.** The Apps Script posted picks and completions to Discord.
   `game_events` was designed to drive this — it has a `relayed_at` column for
   exactly this — but nothing consumes it. An Edge Function or small worker
   reading unrelayed events is the intended shape.
3. **Rotate the Discord webhook URLs** hardcoded in the old Apps Script files on
   Boris's Desktop. Advised repeatedly, never confirmed done.
4. ~~**Scoring.**~~ **Done** — see 0009. Totals are derived by `team_scores`
   (tiles × `points_per_tile` + hits × `points_per_hit` + sinks ×
   `points_per_sink` + manual adjustments), the weights are per-game and
   editable in the admin console, and `score_events` is now written and read
   through `admin_adjust_score` / `admin_list_score_events` /
   `admin_delete_score_event`. Defaults are 1 point per completed tile and
   nothing else, which is what the spreadsheet did. **Not yet seen in a
   browser** — see below.
5. **Captain-facing placement.** `place_fleet` allows a captain, but only the
   admin console calls it — a captain has no UI to place their own fleet.
6. **Delete the demo data** before a real event: the "Demo Match" game and the
   `demo`, `Lil Sod`, `Soft Papi` accounts.
7. **Mobile.** Never tested at phone width, and players will be on phones during
   a raid. The two-board layouts are the risk.
8. **Roster changes are polled, not pushed** (10s). Fine for a waiting room. If
   it matters on the night, emit a `game_event` on roster change.

---

## Traps — things that cost time here

- **Realtime needs the publication, not just the subscription.** A channel can
  report `SUBSCRIBED` and still deliver nothing if its table is not in
  `supabase_realtime`. There is no error anywhere. This is what 0007 fixes, and
  it had silently broken every live update in the app.
- **`CLOSED` from `.subscribe()` is normal once per mount** under React
  StrictMode in dev — subscribe, tear down, resubscribe. Only `CHANNEL_ERROR`
  and `TIMED_OUT` are real.
- **Hooks after an early return crash the app.** `App.jsx` returns early for
  loading/unauthenticated; anything using `useRef`/`useEffect` must sit above
  those returns.
- **`row` and `position` are reserved** in a `RETURNS TABLE` column list. Quote
  them.
- **`RAISE NOTICE` is invisible** through the Supabase MCP tool — return a value.
- **`select f(), (subquery)` in one statement** evaluates the subquery against
  the pre-call snapshot, so it looks like the function did nothing. Check in a
  separate statement.
- **Browser click coordinates refer to the last screenshot.** Scrolling via JS
  and then clicking by coordinate lands in the wrong place. Screenshot first, or
  click by `ref`.
- **The GitHub API rate-limits unauthenticated polling fast** (60/hr). Do not
  poll it in a loop; check the deployed bundle instead.
- **`/repos/…/pages` returns 404 without auth** even when Pages is enabled. It is
  not evidence of anything — fetch the site itself.
- **`python` is not on PATH** in the Bash tool on this machine, and fails
  silently inside a pipeline.
- **Boris's work laptop has no Node, npm or `gh`** — only git and Python. There
  is no local dev server and no local build there, so frontend changes go to
  `main` and are compiled for the first time by GitHub Actions. Check the
  workflow result before assuming a change is live. (`winget install
  OpenJS.NodeJS.LTS` fixes it if that trade stops being worth it.)

---

## What has been verified, and what has not

**Verified:**

- Ship spacing rejected server-side for orthogonal *and* diagonal touches; a
  rejected placement leaves the previously saved fleet intact
- All five admin RPCs refuse a non-admin ("Admins only"); `start_game` too
- Full event flow: create → 100 tiles → open placement → both fleets → start,
  including `start_game` refusing a half-ready board
- Deleting an active game does not trip the fleet-freeze trigger
- Realtime: fired a shot, watched an untouched page update (hits, misses, and a
  ship correctly detected as sunk)
- Waiting room: unassigned player sees the message and no board, then is admitted
  automatically once assigned — tested with the real `Soft Papi` account
- Signup works end-to-end on the live site
- Deployed bundle carries the right key and the current code
- Scoring, server-side, against the live database: `team_scores` totals
  cross-check against `ship_status` and the raw claim counts; `admin_adjust_score`
  refuses a caller with no admin profile; an adjustment moves the total and
  `admin_delete_score_event` puts it back; the `score_adjusted` payload carries
  the delta and no `reason`; and an impersonated Flikkerlikkers player sees both
  teams' totals but **zero** `score_events` rows. Test rows were deleted after.

**Not verified:**

- **The scoring UI in a browser.** The SQL underneath it is tested, but the
  Scoreboard and the admin Score card have never been rendered — they were
  written on a machine with no Node (see Traps) and compiled only by CI.
- A full game played through the player UI by two real people since the V4 rule
  changes. Every game-logic test has been driven from SQL or the admin console.
- Anything at mobile width.
- Behaviour with a realistic team size — everything so far has been 1–2 players
  per side.
