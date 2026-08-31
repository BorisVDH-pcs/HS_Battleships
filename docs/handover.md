# Handover — HS_Battleships

Current as of **2026-08-31**, end of session. Written to be picked up cold, by
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
and therefore **must never carry a tile's name or icon**: the grid is shared, so
naming a tile would reveal it on the reader's own board. (The original Apps
Script author had the same rule — the public webhook omitted tile names.)

### Migrations

`0001` through `0020` are applied to the live project.

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
| `0010_views_to_functions.sql` | `tiles_for_me` and `team_scores` become `security definer` **functions** |
| `0011_drop_definer_views.sql` | Drops the two views, once the frontend calling the functions is live |
| `0012_game_reset_event_type.sql` | Adds the `game_reset` event type (split from 0013 for the same reason as 0008) |
| `0013_reset_game.sql` | `admin_reset_game` — roll a started game back to placement without losing tiles or roster |
| `0014_tile_icons.sql` | Adds `tiles.icon`, drops the unused `tiles.rules`, rebuilds `tiles_for_me` and `admin_list_tiles` around them (drop + recreate, so grants are re-applied) |
| `0015_fleet_placed_event_type.sql` | Adds the `fleet_placed` event type (separate file for the same reason as 0008 and 0012) |
| `0016_place_fleet_emits_event.sql` | `place_fleet` now emits `fleet_placed`, so the admin console sees a captain's placement without a manual refresh |
| `0017_restore_place_fleet_guards.sql` | Restores admin placement, grid-boundary validation and no-touch validation accidentally dropped by 0016, while retaining `fleet_placed` |
| `0018_team_renamed_event_type.sql` | Adds the `team_renamed` event type in its own committed migration |
| `0019_rename_team.sql` | Adds the guarded team-name RPC: admins may rename either team, captains only their own; emits `team_renamed` so open screens refresh |
| `0020_fixed_hit_only_scoring.sql` | Fixes scoring at one point per hit, ignores legacy adjustments, constrains the old weight columns to `0,1,0`, and removes all four scoring-admin RPCs |

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
| `Soft Papi` | **captain**, Kriegsmarine | created by Boris to test signup; promoted while testing |

All four are test accounts except `hs_admin`. Delete the demo data before a real
event — see gaps below.

---

## Running an event

All in the app, signed in as the admin:

1. **New game** — name it and both teams
2. **Tiles** — paste 100 lines in board order, `name | icon` (icon optional).
   Strip the `A1.` prefixes: the box numbers lines by position, it does not
   parse coordinates. With tiles loaded, **Show board**, **Show as list** and
   **Replace tiles** sit together in one action row
3. **Team names** — the admin can rename either team
4. **Open placement**
5. **Roster** — add players, set captains (players must have signed up first)
6. **Fleets** — captains place their own fleet from the player page. The admin
   Fleets card is a read-only live overview of both boards
7. **Start game** — refuses without 2 teams, 100 tiles and 2 complete fleets
8. **Score** — read-only scoreboard. Every hit is one point; nothing else scores

If it goes wrong mid-match, **Reset to placement** rolls the game back without
losing the tiles or the roster — the two things that take real time to set up.
**Reset, keep fleets** does the same but leaves both fleets standing, so you can
replay immediately. Both clear every claim, the feed, the manual adjustments and
the winner, and both emit a `game_reset` event, so open player pages notice by
themselves instead of sitting on a board that no longer exists.

The Fleets card is a live spectator view in every status: one board per team,
its ships plus incoming shots, with sunk/hit counts, updating over Realtime.
There are deliberately no placement controls in the admin page; captains place
from their player page and the `fleet_placed` event refreshes the overview.

### What the admin can see that players cannot

Two views, both fed by `admin_list_*` definer functions that raise
`Admins only` server-side, so neither is reachable by faking a client flag.

- **Tiles card -> Show board / Show as list** — all 100 squares with their real
  names and icons. The grid answers "what is on G7"; the list is for proofreading
  a fresh import against the sheet, and prints the icon *slug* rather than the
  picture so you can see which tile got which. Both stay available once the game
  is `active`, when *editing* tiles is refused. Either view flags squares with no
  tile rather than rendering a silent gap.
- **Both fleets at once** (`AdminBoards`) — one board per team showing that
  team's ships plus the shots the opponent has taken at them. Rendered in every
  game status. It used to appear only after the game left `placement`, which
  hid it during the one phase where "did that fleet save?" is the question
  being asked.

Between them these are the game's two secrets, which is why the admin account
is separate from every player account and `is_admin` is grantable only by SQL.

### What players see

- **Signed up, no team yet:** "You are not assigned to a team yet. Come back once
  teams have been made." No board. The page polls every 10s and admits them by
  itself once assigned — roster changes emit no `game_event`, so Realtime cannot
  carry this.
- **On a team, during `placement`:** a captain gets a **Place your fleet** card
  and can reposition freely until the game starts; a member gets a line saying
  their captain is doing it. The admin console only watches both fleet boards;
  it does not expose placement controls.
- **Captain, in every game status:** gets a **Your team** card and may rename
  their own team. `rename_team` refuses members and cross-team captain changes;
  its event updates open player and admin screens.
- **On a team, once `active`:** enemy waters (claimable), their own fleet with
  incoming shots, their active tile slots, the scoreboard, and the event feed.

Every board labels its squares `A1`..`J10` — the coordinate, not the 1..100
position, because that is what people say out loud and type into Discord. A
shot marker outranks the label: a hit shows a cross, a claimed-but-unfired tile
shows a dot, and a claimed tile shows its **icon** if it has one.

Claiming asks for confirmation, as firing already did. A cell is a small target
on a phone and a claim costs one of the team's active slots until it is fired.

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

Then hard-refresh (Ctrl+F5) — the browser caches the previous bundle. This bites
often enough to be the first thing to rule out: twice more since that was
written, a change looked missing and was simply a cached stylesheet.

**Tile icons need no build step.** `web/public/icons/*.png` is copied verbatim by
Vite, so an icon is live as soon as it is committed. To add one, drop the source
art in `tools/icon-src/` (gitignored) and run:

```bash
python tools/make_icons.py
```

It writes a square 64px PNG per source file and prints the slug to use after the
pipe in the admin paste box. 64px because a cell is 30-50px and phones are 2x;
the raw wiki renders are 100-1280px and average 92 KB against roughly 4 KB here.

> Note that `web/public/icons/` is **public**, like the rest of the repo. The
> filenames — and the pictures themselves — reveal the pool of tasks, though not
> which square each sits on. Renaming them to something opaque does not help,
> since anyone can open the folder and look. Accepted deliberately.

---

## Known gaps / next steps

Roughly in priority order:

1. ~~**Real tile content.**~~ **Done.** The 100 V4 tiles are loaded into Demo
   Match. Names only, no `rules` — the source list did not have any.

   **The tile list is not in this repo, and must not be.** This repo is
   public, and tile contents are secret #2 (see architecture.md, "The two
   secrets"): committing the list would publish exactly what `tiles_for_me`
   exists to hide. It lives in the Middleman sheet and in the database. If
   you need to re-import, paste the sheet's `Tile Data` into the admin box.

   Tiles carry a `name` and an optional `icon`. There is no `rules` column —
   it was dropped in 0014, empty, because the V4 board has none.

   Import notes for next time:
   - The sheet labels squares `A1`..`J10`, where the **letter is the column
     and the number is the row** — matching `coordLabel()` in `board.js`.
     Listed reading order (A1, B1, ... J1, A2, ...) is already
     `position = (row-1)*10 + col`, so no re-sorting is needed.
   - Verify the import by checksum rather than by eye:
     `select md5(string_agg(name, '|' order by position)) from tiles where
     game_id = ...` and compare against the same hash computed on the source.
     That catches a transcription slip that spot-checking will not.
2. **Tile icons — 10 of ~90 done.** The plumbing is finished (0014, `TileIcon`,
   `tools/make_icons.py`); what is left is artwork. Ten tiles have an icon; the
   rest fall back to their coordinate, which is the pre-icon board, so this is
   cosmetic and safe to leave half-done through an event.

   Only ~21 of the 90 distinct tile names matched anything in the set at
   `iftachShoham/HighSociety-Bingo` — that bingo had different tasks — so most
   still need sourcing. Decided against category icons (`slayer`, `raids`, ...)
   in favour of per-item art, and against opaque filenames, since anyone can
   open the public folder and look at the pictures regardless.
3. **Discord relay.** The Apps Script posted picks and completions to Discord.
   `game_events` was designed to drive this — it has a `relayed_at` column for
   exactly this — but nothing consumes it. An Edge Function or small worker
   reading unrelayed events is the intended shape.
4. **Rotate the Discord webhook URLs** hardcoded in the old Apps Script files on
   Boris's Desktop. Advised repeatedly, never confirmed done.
5. ~~**Scoring.**~~ **Done** — see 0020. `team_scores` is the count of fired
   hits: one hit is one point and nothing else scores. The admin card is
   read-only. Configurable weights and manual-adjustment RPCs were removed;
   legacy rows remain stored but are ignored.
6. ~~**Captain-facing placement.**~~ **Done.** A captain now sees a "Place your
   fleet" card on their own page during placement, and can reposition until the
   admin starts the game. Members get a waiting message. `place_fleet` always
   allowed this — only the UI was missing.
7. **Delete the demo data** before a real event: the `demo`, `Lil Sod` and
   `Soft Papi` accounts. **Note the game itself now holds the real tiles** —
   "Demo Match" is only a name at this point. Rename it rather than deleting
   it, or re-import the tiles into whatever replaces it.
8. **Mobile.** Partly addressed. Measured at 375x812: no horizontal page
   scroll, all three grids fit, the page is about 2.7 screens tall. Three
   things were fixed after that measurement:
   - cells were ~24px, about half the ~44px a thumb wants. Small screens now
     trim the page padding, card padding, row-number gutter and cell gap and
     spend all of it on the cells, which reaches 30px at 375px with the whole
     10x10 still on screen (measured, not guessed). `overflow-x` on `.board`
     is a safety net for anything narrower;
   - `FleetPlacer` took its placement preview from hover, which a phone does
     not have, so a tap dropped a hull blind. Coarse pointers now aim on the
     first tap and commit on a second tap of the same cell. Rotation always
     had a button as well as the `R` key.
   - claiming a tile now asks for confirmation, as firing already did.

   **Still unverified on a real phone.** All of the above was written without
   Node on the machine and checked by balance-checking the sources and
   grepping the deployed bundle. Someone should open the live site on an
   actual handset before the event.
9. **Tests.** There are none, of any kind. This is the single biggest
   difference between this repo and iftachShoham/HighSociety-Monopoly, and it
   is largely a consequence of the architecture: the rules live in PL/pgSQL
   `security definer` functions, which are awkward to test without a local
   Postgres. pgTAP is the route if it matters.
10. **Admin audit log.** `admin_reset_game` destroys a match's claims, feed and
   score adjustments and leaves no record of who pressed the button. Offered,
   not yet built.
11. **Roster changes are polled, not pushed** (10s). Fine for a waiting room. If
   it matters on the night, emit a `game_event` on roster change.
12. **A second version, on a different architecture.** Decided 2026-08-30: after
   the event, build the game again the way `iftachShoham/HighSociety-Monopoly`
   is built — Hono on Cloudflare Workers, D1, TypeScript services layered
   `routes -> services -> repositories -> domain`, shared Zod schemas, Vitest —
   and compare the two honestly.

   The trade is real in both directions. RLS fails *closed*: a query that
   forgets its filter returns nothing, which is exactly what happened to
   `ship_cells` in `useGame` and turned a fleet leak into a cosmetic bug. A
   service over D1 fails *open* — the same mistake returns every row. Against
   that, logic in TypeScript is far easier to test, read and run locally than
   the PL/pgSQL this app keeps its rules in, which is why that repo has tests
   and this one has none (gap 9).

   **This version is frozen architecturally until the event is over.** Build v2
   as a separate repo, not a branch, so the comparison stays honest.

---

## Traps — things that cost time here

- **No event means no refresh, forever.** The admin console and every player
  page refetch when a `game_events` row appears for the game, and nothing else
  triggers them. An RPC that changes state without emitting an event leaves
  every other screen stale indefinitely — not a cache that ages out, no signal
  at all. `place_fleet` had exactly this bug until 0016: a captain placed a full
  fleet and the organiser's screen kept saying "No fleet placed yet". Roster
  changes still have it, which is why the waiting room polls (gap 11). If you
  add a state-changing RPC, emit an event from it.
- **A component that is not mounted cannot be stale.** Before blaming Realtime
  for a screen that will not update, check that the thing you expect to see is
  rendered at all. `AdminBoards` sat in the `else` branch of the Fleets card's
  status ternary, so during `placement` it was simply absent, and no refresh or
  event could have helped. The symptom — "the admin does not see the fleet" —
  is identical to a missed event, which is what made it easy to misdiagnose.
  The card now renders only `AdminBoards`, in every status.
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
- **The security advisor cannot be silenced per-object.** There is no dismiss or
  ignore; the only way to clear a lint is for the object to stop matching it.
  That is why `tiles_for_me` and `team_scores` are functions and not views
  (0010/0011) — `security_definer_view` is CRITICAL and fires on views only.
  Nothing about the security changed. The remaining `authenticated ... can
  execute SECURITY DEFINER function` warnings — one per RPC — are inherent to the
  design, since every write and every gated read in this app is a definer RPC on
  purpose, and are expected to stay. What matters is that the error count is
  **zero**; do not chase the warning count, it grows with each new RPC.
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
- **Bash heredocs collapse backslashes** on this machine. A `<<'PY'` heredoc is
  supposed to pass its body through untouched, but a doubled backslash arrives
  as a single one. That silently breaks regexes and any string match against a
  JS escape sequence, and the failure looks like the pattern is wrong rather
  than the plumbing. Build such strings with `chr(92)`, or use the Write tool
  and run the file. This cost time three times, including once while writing
  this very bullet.
- **Dropping a function drops its grants.** `create or replace` cannot change a
  `RETURNS TABLE` list, so changing one means `drop` + `create` — and the new
  function comes back with no grants and PUBLIC's implicit EXECUTE. Re-apply the
  revoke/grant pair in the same migration (0014 does) or every player silently
  loses the board.
- **Windows Python cannot see the Bash tool's `/tmp`.** Git Bash maps it
  elsewhere; write to the scratchpad with a `C:\...` path instead.
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
- Scoring, server-side, against the live database: every `team_scores.total`
  equals its hit count, all returned adjustments are zero, the old weight
  columns are `0,1,0`, their database constraint rejects other values, and the
  four scoring-admin functions no longer exist.

- Captain placement, server-side: a captain who is **not** an admin placed a full
  fleet through `place_fleet` on a throwaway game in `placement`; a plain member
  of the same team was refused with "Only a team captain or an admin may place
  the fleet". The throwaway game was deleted afterwards.
- The admin Score card in the browser: only the two-team scoreboard remains;
  there are no weight, manual-adjustment or adjustment-history controls.
- The admin tile board (**Show board** / **Show as list**), in the browser, by
  Boris.
- **The 100 V4 tiles**, by checksum rather than by eye:
  `md5(string_agg(name, '|' order by position))` matched the same hash computed
  on the source paste, so all 100 names round-tripped byte-identical and in
  board order. Seven coordinates spot-checked against the sheet's labels.
- **Redaction, re-tested after 0014** — as a real (non-admin) player,
  `tiles_for_me` returns 100 rows with **0 names and 0 icons** while 10 tiles
  have icons set, and a direct read of `tiles` returns **0 rows**. The loaded
  page made **0 requests** to `/icons/`, so nothing leaks through the network
  log either.
- **Mobile layout, measured** on the live site at 375x812: 30x30 cells, all of
  A-J visible, zero overflow on both board and page, 44px yard buttons,
  `pointer: coarse` matched and the touch instructions rendered.
- All ten committed icons serve HTTP 200 at
  `/HS_Battleships/icons/<slug>.png` with the expected byte sizes.
- **`place_fleet` emits `fleet_placed`** — replayed a captain's real fleet
  through the RPC inside a transaction: one event, payload `{"ships": 5}`, no
  `row`/`col` anywhere in it. Rolled back, and the fleet was intact afterwards
  (5 ships, 17 cells, sizes 2,3,3,4,5) with zero leftover events.
- **The overview renders during placement**, in the deployed bundle: the
  `AdminBoards` call sits as a sibling of the status ternary rather than inside
  its `else`.

**Implemented after this handover was first written:**

- Team-name editing is live from commit `c518812`. Admins get both names in a
  **Team names** card; captains get only their own in **Your team**, in every
  game status. The `rename_team` RPC was production-tested in rolled-back
  transactions: admin-own/either-team and captain-own succeeded, a cross-team
  captain rename was refused, the Realtime event was created, and no test name
  or event remained. The deployed admin UI was verified with both inputs.
- The Tiles card's **Show board**, **Show as list** and **Replace tiles** buttons
  now share one non-wrapping row. Verified in the deployed bundle
  `index-Cu1Bg-Iw.js` at the normal viewport and at 375x812: identical top edges,
  all three within the card, and no horizontal page overflow.
- `0017_restore_place_fleet_guards.sql` fixes a regression in 0016. That
  migration had been based on the pre-0006 `place_fleet` body and therefore
  removed the admin exception, the grid-boundary check and the server-side
  no-touch check. 0017 restores all three and keeps the redacted
  `fleet_placed` event. Applied to the live project and verified in a rolled-back
  production transaction: admin placement succeeded with 5 ships / 17 cells,
  off-board and touching fleets were rejected, and the event payload contained
  only `{"ships":5}`.
- The admin fleet placers briefly loaded the persisted fleets in commit
  `b9f42f7`, but were removed on Boris's instruction: placement belongs on the
  captain page. The admin Fleets card now contains only the two live overview
  boards with coordinates, ships, hits, misses and active claims. Deployed from
  commit `530c82b` as bundle `index-9cmobK4X.js` and verified in the signed-in
  live admin panel: zero `.placer` components and exactly two overview grids.

**Not verified:**

- **Placing a fleet by touch, end to end.** The aim-then-confirm path was
  written blind and only the rendered card has been seen, never a hull actually
  dropped with a thumb. This is the first thing every captain does, so it is
  worth two minutes on a real handset.
- **The overview showing a fleet in Boris's own browser.** The markup is
  confirmed deployed and the data is confirmed present (Kriegsmarine: 5 ships,
  17 cells), but nobody has yet seen the two meet on screen.
- **An icon rendering on a claimed tile.** The redaction direction is proven
  (above); the *showing* direction needs a live claim on a tile that has an
  icon — try G1.
- A full game played through the player UI by two real people since the V4 rule
  changes. Every game-logic test has been driven from SQL or the admin console.
- **Anything on a real phone.** The measurements above were taken in an emulated
  375x812 viewport, which gets layout and `pointer: coarse` right but is not a
  handset.
- Behaviour with a realistic team size — everything so far has been 1–2 players
  per side.
