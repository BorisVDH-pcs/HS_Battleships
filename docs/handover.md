# Handover — HS_Battleships

Current as of **2026-09-01**, end of session. Latest work is in the session log at the bottom. Written to be picked up cold, by
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

`0001` through `0027` are applied to the live project.

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
| `0021_evidence.sql` | `tiles.required_evidence`, the `tile_evidence` table (select policy and nothing else, so submitted proof cannot be edited or deleted by anyone using the app), the private `evidence` storage bucket and its policies, `add_evidence`, `list_my_evidence`, `admin_list_evidence`, and the `claims_need_evidence` trigger |
| `0022_admin_tile_progress.sql` | `admin_tile_progress` — every claim in a game with its evidence count, for the organiser's board |
| `0023_evidence_fires.sql` | `add_evidence` now fires the shot itself in the same transaction once the requirement is met, so "fully evidenced but still active" cannot exist |
| `0024_one_team_per_game.sql` | `my_team_in_game()`, and `tiles_for_me` / `my_evidence` / `claim_tile` scoped through it, so a player sitting in both teams of one game no longer sees the two sides merged |
| `0025_early_completion.sql` | `tiles.early_complete`, `tile_claims.completed_early`, the evidence cap raised 10 → 30 (function clamp **and** table constraint), `complete_tile_early`, and `admin_set_tiles` / `tiles_for_me` / `admin_list_tiles` carrying both through |
| `0026_sunk_from_cells.sql` | `ship_status` decides `sunk` from the cells a ship occupies rather than the stored `ships.size`, counting DISTINCT hit cells with `>=`; `fire_tile` announces the derived size; `assert_fleets_consistent` added and called from `start_game` |
| `0027_fire_only_while_active.sql` | A shot may only be fired while the game is `active`. `fire_tile`, `add_evidence` and `complete_tile_early` all refuse once a game is finished, and the winner update is narrowed to `status = 'active'` so a win cannot overwrite a win |

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
"Bludgenmaker"  ->  bludgenmaker@players.hs-battleships.invalid
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
| `demo` | unassigned | throwaway |
| `Bludgenmaker` | **captain**, Team Bravo | active replacement for the removed `Lil Sod` test account |
| `Soft Papi` | **captain**, Team Alpha | created by Boris to test signup; promoted while testing |

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
- **Boards** (`AdminOverview`) — one board per team, drawn from that team's
  side of the game: the **opponent's** hulls they are hunting, with their own
  claims and shots painted on top. Alpha's board therefore carries Bravo's
  ships and Alpha's hits, so reading it is reading Alpha's game. There is
  deliberately no second copy of each fleet; the earlier `AdminBoards` and
  `AdminTileBoards` drew the same fleets twice and are deleted. Rendered in
  every game status, including `placement`, which is the one phase where "did
  that fleet save?" is the question being asked.

  A claimed square shows its evidence count (`1/3`), and clicking any claimed
  square opens `EvidencePanel` — the screenshots for that tile, each with the
  name of the member who submitted it. Signed URLs are minted only for the tile
  actually open. The card refreshes on `game_events` Realtime plus a 20s poll,
  because an upload emits no event.
- **Evidence review** (`EvidenceReview`) — the same submissions as a flat list
  across the whole game, for reading through in order rather than by square.

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
shot marker outranks the label, and a claimed tile shows its **icon**.

**The colour language** (`styles.css`, top of file) — a hit is one event with
two meanings, so it has two colours:

| | Looks like | Means |
|---|---|---|
| `.cell.hit.dealt` | **bright green** fill, solid burst `✸` | a hull *you* struck — enemy waters, and every admin board |
| `.cell.hit` | red fill, solid burst `✸` | damage *you took* — your own fleet only |
| `.cell.miss` | water blue, hollow ring `○` | a square already spent |
| `.cell.ship` | **muted** green | your hull (or, on an admin board, an enemy hull still afloat and unstruck) |
| `.cell.active` | gold outline, `1/3` | claimed, not yet fired |

A fired square **keeps its artwork**: the coloured ground and the mark sit on
top of the picture rather than replacing it, so a board that has been shot at
for an hour still reads as a board of tasks. `.cell` is already a centred grid,
so the two are stacked with a shared `grid-area: 1 / 1` rather than absolute
positioning — the mark stays centred at every cell size, phone included.

Red therefore only ever means harm to the person reading it. Filled-versus-
hollow carries the same distinction without hue, which matters because ship
green and hit red are the pair a deuteranope cannot separate. `BoardLegend`
prints this under both player boards — enemy waters names no ship colour on
purpose, since an undamaged enemy hull is still secret.

**Evidence.** A claimed tile is worked from the **Active tiles** slots: drop,
paste or pick screenshots, and the submit that meets `required_evidence`
*is* the shot — `add_evidence` fires it in the same transaction (0023), so a
tile cannot sit fully evidenced and still hold a slot. Submitted evidence is
immutable; staging exists so the change-your-mind step happens before upload.
Clicking any square the team has claimed reopens `EvidencePanel` with what they
submitted, the same component the organiser sees.

**Artwork.** Ten of the ~90 tiles have real art. A claimed tile with none
borrows the dragon warhammer (`TileIcon`, `standIn`), so a claimed square never
looks like an unclaimed one. An *unclaimed* square still renders no image at
all — no slug, no request, nothing in the network log.

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

0. **A locked-in tile cannot be released.** There is no `unclaim` RPC anywhere,
   and no UI for one. A tile leaves `active` only by firing, which needs its
   full evidence count. So a team that locks in a square it cannot actually
   finish has lost one of its two slots for good — and two such squares and
   **that team is out of the game**. The only ways back are
   `complete_tile_early` (flagged tiles only), `admin_reset_game` (which
   destroys every locked-in tile, the feed and the score), or hand-written SQL
   on the night.

   Found by simulation, not yet fixed, because it is a design decision rather
   than a bug: an admin-only release is safe, while letting a captain drop a
   square themselves turns lock-in into a way to *read* a tile name and then
   back out, which leaks secret #2. Admin-only, emitting a `game_event` so open
   screens refresh, is the recommendation. Worth doing before a real event —
   "we misread the tile and locked in the wrong square" is going to happen.

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
   `tools/make_icons.py`); what is left is artwork. In Demo Match 10 of the 100
   tiles have an `icon` slug and 90 are null, so most claimed squares currently
   show the dragon warhammer stand-in. Cosmetic, and safe to leave half-done
   through an event — but the stand-in means an undrawn tile no longer *reads*
   as undrawn, so count slugs in the database rather than looking at the board
   when you want to know what is left.

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
7. **Delete the demo data** before a real event: the `demo`, `Bludgenmaker` and
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

- The old `Lil Sod` account was replaced by the already-created
  `Bludgenmaker` account. The active account keeps its password and Team Bravo
  captain membership; its profile and Auth metadata now consistently show
  `Bludgenmaker`, and the unused `Lil Sod` login was removed. The New game form
  now uses `Team Alpha` and `Team Bravo` as the two team-name placeholders.
  Verified live in the signed-in admin panel from bundle `index-DwgXBECL.js`:
  the roster shows `Bludgenmaker · captain`, contains no `Lil Sod`, and both
  placeholders render with the new examples. Bludgenmaker's password was reset
  on 2026-08-31 and verified by matching the new value against Supabase's stored
  hash; the password itself is deliberately not recorded here.
- Fixed hit-only scoring is live from commit `12dfb52` and migration 0020.
  Production verification showed every game at weights `0,1,0`, every returned
  total equal to its hit count, zero returned adjustments, the fixed-rule check
  constraint validated, and all four scoring-admin RPCs absent. The deployed
  bundle `index-DPFEbTcC.js` was verified in the signed-in admin panel: the Score
  card has two team rows, zero controls, and none of the removed section labels.
  The database advisors report no errors; the remaining warnings are the known
  intentional definer-RPC/auth notices documented below.
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
  confirmed deployed and the data is confirmed present (Team Bravo: 5 ships,
  17 cells), but nobody has yet seen the two meet on screen.
- **An icon rendering on a claimed tile.** The redaction direction is proven
  (above); the *showing* direction needs a live claim on a tile that has an
  icon — try G1 in Demo Match. The dragon-warhammer stand-in for a claimed tile
  with no art is unseen too.
- **Anything on the player side of the evidence work**, in a browser. All of it
  was verified server-side (see below) and the organiser's half was verified on
  screen, but nobody has watched a player upload a screenshot, see `1/3` become
  `3/3`, watch the shot go off, or click a claimed square to read their own
  submissions back. There is no player password in this repo, and the sessions
  that did this work only ever had the admin login.
- **The red hit on your own fleet.** Enemy-waters hits and water-blue misses
  were confirmed on the deployed admin board; the fleet-owner's red needs a
  player session with incoming shots against it.
- A full game played through the player UI by two real people since the V4 rule
  changes. Every game-logic test has been driven from SQL or the admin console.
- **Anything on a real phone.** The measurements above were taken in an emulated
  375x812 viewport, which gets layout and `pointer: coarse` right but is not a
  handset.
- Behaviour with a realistic team size — everything so far has been 1–2 players
  per side.


---

## Session log — 2026-08-31, evidence and board colours

Commits `48c1c25` … `61ab3e3` plus migrations `0021`–`0023`, all deployed and
applied live.

**Evidence.** Any member may submit; the submitter's name is recorded on every
row (`uploaded_by_name`) and shown wherever evidence is read. Admins review but
do not approve — there is no approval state to get stuck in. `tile_evidence`
has a select policy and nothing else, and the `evidence` storage bucket has no
update or delete policy, so a player cannot retract proof after submitting it.
Storage paths are `{game_id}/{team_id}/{claim_id}/{uuid}.webp`; the bucket
policies key on **path segment 2**, the team id, and `add_evidence` re-derives
the whole prefix server-side and rejects a path that does not match the claim.

**Why 0023 exists.** Boris found a tile reading `1/1` that had not fired, and
ruled that the state must be impossible rather than recoverable: *"Only free an
active tile once the old one fired."* The client used to call `add_evidence`
then `fire_tile`, with a network between them. Now the requirement being met
fires the shot inside the same transaction, under `for update` on the claim, so
two members submitting the last piece at the same moment cannot double-fire.
The **Complete & fire** button in `ActiveTiles` is kept only as a rescue hatch
for rows predating this, and for anything an organiser edits in by hand.

**Verified server-side, on the live database**, by impersonating a real member
with `set_config('request.jwt.claims', …)`: the 2nd of 3 submissions did not
fire, the 3rd returned `fired: true` with a result, and a 4th was refused with
"That tile has already been fired". A full audit found zero claims holding full
evidence while still active.

**Board colours** (`61ab3e3`) — the change described under *What players see*.
Verified on the deployed admin board (when a dealt hit was still ember; it is
green from 2026-08-31): a burst at E2, hollow water rings
at H7 and B9, a gold `2/3` claim at C4, green enemy hulls elsewhere.

**Artwork under the marks** — a fired square no longer swaps its picture for a
glyph. The icon dims (`.62` under a hit, `.5` under a miss) and the mark carries
its own shadow, which is what keeps it legible over whatever the art happens to
be. Checked against a grid of stand-ins at hit, miss and claimed states.

One board is still artwork-free on purpose-for-now: the **admin overview**
renders coordinates and evidence counts, never icons, because
`admin_tile_progress` does not return `tiles.icon`. Adding it is a one-column
migration if an organiser ever wants the pictures there too.

### Leftovers to clean up

A throwaway game **"Evidence Demo (scratch)"**
(`eeeeeeee-0000-0000-0000-0000000000f0`, teams Demo Alpha `…000a` / Demo Bravo
`…000b`) was built to test all of this against real storage and real RLS rather
than against Demo Match, which stayed in `placement` and untouched. It is still
there, and deleting it is safe:

- the game itself, its tiles, claims and evidence rows;
- the uploaded objects under its `game_id` prefix in the `evidence` bucket;
- two or three `tile_evidence` rows on claim `…00c5` whose storage objects were
  never actually uploaded (the RPC was called directly during testing), so they
  render as broken thumbnails;
- `Soft Papi`'s membership of **both** scratch teams — added so one browser
  session could act for either side. Check this before a real event.

Demo Match is unaffected by all of the above.

---

## Session log — 2026-08-31 (later), the first real player session

The first time anybody signed in as a **player** in a browser. Everything before
this had been driven from SQL or the admin console, which is why the bug below
survived twenty-three migrations.

**Verified in a browser, player side** (previously all "not verified"):

- The evidence UI renders: tile art, `0/2` and `2/3` counters, coordinate
  badges, drop zones.
- `EvidencePanel` read-back from a player's own board — signed-URL thumbnail,
  submitter name, timestamp, `fired, hit`.
- The **dragon-warhammer stand-in** on a claimed tile with no art of its own.
  Exactly **one** `/icons/` request in the whole network log, so the redaction
  direction still holds where it matters.
- The **red hull hit** on your own fleet (J10), correctly distinct from the
  ember on enemy waters, with the fleet-owner legend wording.
- **0023 fires and emits its event**, proven from production rather than from
  reading the code: evidence row `test-4.webp` and its `shot_fired` event share
  the timestamp `18:05:12.38501+00` to the microsecond. `now()` is
  transaction-scoped, so they were one transaction.

### The bug: two memberships merged the two sides of a game

`Soft Papi` sits in **both** scratch teams — added deliberately last session so
one browser could act for either side. That made a latent bug visible.

`my_team_ids()` answers "every team this player has ever been in, in any game".
That is correct for the RLS policies and wrong for anything asking "my side of
*this* game". Three callers asked the second question with the first function:

- **`tiles_for_me`** left-joined claims from both teams. A tile claimed by each
  side returned **twice** — measured at **101 rows for a 100-tile board**, with
  a duplicate cell rendered on the grid — and the opponent's claims were painted
  on the player's own board. Worse, they arrived in the **active-tile slots**
  complete with working upload controls: a drop on Bravo's claim from Alpha's
  board submitted evidence for Bravo and passed `add_evidence`'s membership
  check while doing it. The slot counter read `2/2` when Alpha held one claim.
- **`my_evidence`** returned both sides' uploads (9 rows instead of 5).
- **`claim_tile`** used an unordered multi-row `select ... into`. PL/pgSQL does
  not raise on that — it takes an arbitrary row — so a claim landed on **either
  team**, nondeterministically and silently.

Frontend, separately: `ship_status` was filtered by `game_id` but **not** by
team, unlike `ship_cells` on the line above it, so the fleet header read
**"10 afloat"** against a five-ship fleet. Both scratch fleets are on identical
coordinates, so the *cells* looked right and only the count gave it away.

**Fixed** by `0024` plus one frontend line. `my_team_in_game(p_game_id)` returns
a single team, breaking the tie by team **name** so it agrees with the frontend,
which takes the first of `teams` ordered by name.

Verified against the live database by impersonating Soft Papi, and then in the
browser: `tiles_for_me` returns **100 rows, 0 duplicated positions, 4 claims**
(Alpha's only), `my_evidence` **5 rows**, `my_team_in_game` picks Demo Alpha,
and the deployed page went from `Active tiles (2/2)` to **`Active tiles (1/2)`**
with an "Empty slot" beside it. A1 and J10 — Bravo's claims — are `not yet
claimed` again, and the grid is **100 cells** with exactly four marked squares.

Deliberately **not** a constraint forbidding two memberships in one game: one
browser acting for both sides is a useful testing trick, and Boris used it on
purpose. The point of 0024 is that the state now renders honestly instead of
blending. If that trade ever stops being worth it, a trigger on `team_members`
is the place.

> **Trap, freshly paid for.** `create or replace` on `tiles_for_me` failed with
> *cannot change return type*, because the current definition is the one in
> **0021**, not the newer-looking one in 0014 — the evidence work added
> `required_evidence` and `evidence_count` to the return table. Read
> `pg_get_functiondef()` before rewriting a function; the highest-numbered file
> that mentions it is not necessarily the one that defines it.

### Kriegsmarine and Flikkerlikkers are not users

Evidence in the scratch game is signed by names that are not accounts, which
looks alarming and is not. Every `tile_evidence` row has `uploaded_by` =
Soft Papi's uuid; only the denormalised `uploaded_by_name` varies, across
`Kriegsmarine`, `Flikkerlikkers`, `Bludgenmaker` and `Soft Papi`. Six rows share
the timestamp `16:15:35.23725+00` and one sits exactly an hour earlier with the
same fractional seconds — a seeded batch.

`add_evidence` always writes `uploaded_by_name` from `profiles.display_name` for
`auth.uid()`, so it **cannot** produce a mismatched name. Those rows were direct
inserts from a session holding service-role access, seeding plausible OSRS names
so the review screens looked populated. There are still only four accounts:
`demo`, `HS Admin`, `Soft Papi`, `Bludgenmaker`. Nobody signed up unnoticed.

### The player loop, finally driven by a human

`window.confirm` is why nobody had ever completed a tile from a browser.

Both halves of the player loop were gated on it — claiming a tile
(`App.jsx`) and the submit that fires the shot (`EvidenceUploader.jsx`) — and a
WebView draws a native dialog only if its host implements the JS-dialog
delegate. Where the host does not, `confirm()` returns **false immediately
without drawing anything**: measured at **1ms** in this app's own embedded
browser. The caller cannot tell that apart from someone pressing Cancel, so the
button silently did nothing. No request, no error, nothing in the console.

The gate was also **asymmetric**: a submit that does not complete a tile never
asked. So a player could upload the first two pieces of evidence perfectly
normally and find only the third silently refusing — which is a maddening bug
report to receive on the night, and the reason this is worth understanding
rather than just patching.

All five native dialogs are now `ConfirmDialog.jsx`, a promise-based
`useConfirm()` hook so the call sites keep their old shape
(`if (!(await confirm(...))) return;`). Escape cancels; Enter is deliberately
unbound, since these stand in front of irreversible actions and a reflex press
on the key that submitted the form behind them should not fire a shot. Unmount
resolves `false`, so a screen that goes away mid-question cannot strand the
caller's `busy` flag. `requireText` replaces the `window.prompt` on game
deletion and is stricter — the confirm button stays disabled until the name
matches, rather than accepting anything and reporting the mismatch after.

The `useConfirm()` call in `App.jsx` sits above the early returns, per the trap
above. Its dialog is last in the tree and `position: fixed`; checked that no
ancestor carries a `transform` or `filter` that would trap it inside a card, and
`z-index: 50` is the only z-index in the stylesheet.

**Verified — the first tiles ever completed through the UI.** Boris ran four
claim → upload → fire cycles in 51 seconds, each through two dialogs:

| Time | Event | Tile |
|---|---|---|
| 19:04:04 | `shot_fired` miss, pos 33 | the tile that had been stuck |
| 19:04:10 / :13 | `tile_claimed` pos 13, 17 | both slots held at once |
| 19:04:22 / :33 | `shot_fired` **hit**, pos 17 then 13 | |
| 19:04:38 | `tile_claimed` pos 24 | |
| 19:04:55 | `shot_fired` miss, pos 24 | |

Every claim and every shot emitted its event, so the feed and every open screen
now refresh. Four real WebP objects landed under
`{game}/{team}/{claim}/{uuid}.webp`, each written 0.2–0.3s before its shot
event — so the browser re-encode, the path scheme, the storage-then-register
order and 0023's same-transaction fire all hold from a real browser, not just
from SQL. The two-active-slot limit held with two claims open at once. Claiming
and cancelling was confirmed not to create a claim.

### Still not verified

- The `ship_status` filter and the dialog work are **built but not deployed** —
  the live bundle is still `index-CLAWmv2s.js`. Until a push, a player on the
  live site still meets the silent `confirm` and still reads "10 afloat".
  Migration 0024 **is** live and is independently safe.
- **A real handset.** Everything above was an emulated viewport at a 1.25 device
  pixel ratio. The dialog's stacked 44px actions under 620px are unseen on
  glass, and touch fleet placement is still untried.
- A full two-person game since the V4 rule changes.

---

## Session log — 2026-08-31 (later still), the real board

### The 100 tiles are in, with art and evidence counts

Demo Match holds the real V4 board: 100 tiles, 100 icons, per-tile evidence
counts, and nine tiles flagged as having more than one route to done.

Verified by checksum rather than by eye, all three matching the source exactly:

| | |
|---|---|
| names | `869004d9a21d11c6c7faec51c91d5df8` |
| icons | `bbbee3832b7c710f28b8684494a82af8` |
| amounts (with `+`) | `48d9b8dc8e24a6ed06df71f75ce5e2ee` |

Positions 1–100 all distinct, 91 distinct icons, max amount 20, 318 uploads if
every tile were taken the long way.

**The old name checksum was identical to the new one.** Demo Match already held
exactly this list of names — so the import added the icons and the amounts, and
changed no tile text at all. The old rows are in
`tiles_backup_demo_match_pre_import`; drop it when it stops being reassuring.

**The tile list is still not in this repo and must not be.** It lives in the
database and the Middleman sheet. The paste-ready block was handed over as a
file outside the repo.

### Icons: 91 of 91

Sourced from the OSRS wiki, every name checked against the wiki API before
downloading rather than guessed — which was worth doing, because several were
wrong — four of the names Boris supplied resolved, via the API's own
redirects, to differently-named pages, and one was simply a misspelling. The
corrected slugs are in `web/public/icons/`; the mapping from square to slug is
not recorded here, for the same reason the tile list is not.
5.7 MB of renders down to 393 KB through `tools/make_icons.py`.

Where a square is about drops from one specific boss, the icon is **that boss**
rather than one of its drops (Boris's call). It reads better and it covers the
squares where no single item could stand for the set. Ten of the eleven item
icons that displaced are gone; `serpentine_visage` was downloaded and then
deleted once the square it was drawn for took a boss icon instead, so nothing
unused is published.

The filenames are public, and at 91 they disclose essentially the whole task
pool — minus which square each sits on, which is the part that decides the game.
Accepted deliberately, extending the trade the first ten icons already made.

### Tiles with more than one route (0025)

Some tasks can be finished several ways at different prices — "three of this,
nine of that, or eighteen of the other". Others ask for one complete set out of
several candidate sets, where the worst case is a **pigeonhole** count, not the
set size: six candidate sets of four pieces means three near-misses across all
six (eighteen) before the nineteenth must complete one. A second such tile has
three candidate sets of four, so ten.

Pricing those at the cheapest route was wrong — a team taking the long way round
would have fired after three uploads looking under-evidenced. So **the amount is
the worst case, and the team declares when it is actually done.** Nine tiles are
flagged: the two set-completion ones and seven either/or ones.

- `tiles.early_complete` is per tile, so a team cannot declare a plain
  five-drop tile finished — that has one route and the number is the whole of it.
- `complete_tile_early()` requires membership, an unfired claim, the tile flag,
  and **at least one screenshot**. Without that floor, claim-then-declare would
  be a free shot with no proof.
- `tile_claims.completed_early` records it, because an early completion is
  self-declared and the organiser must see which fires were. No new function was
  needed: `admin_tile_progress` already returns `required_evidence`, `status`
  and `evidence_count`, so an early completion reads as fired-with-fewer.
- The 0021 trigger stays exactly as strict for every other tile. This adds a
  second legitimate way to satisfy it, not a way around it.

Paste syntax gained a third field and a marker: `name | icon | amount`, with a
trailing `+` for a tile with a short route — `… | infernal_cape | 18+`.

**Verified against the live database** in a rolled-back transaction: an
unflagged tile refused an early completion, a flagged tile with zero evidence
refused it, and a flagged tile with one screenshot against a required two fired
and returned `declared_early: true`. The rollback left the claim active with no
evidence and no events.

> **Two traps paid for here.** The evidence cap lived in **two** places — the
> clamp inside `admin_set_tiles` and a check constraint on the table. Raising
> only the clamp gets a constraint violation on import, which is the good
> outcome; the clamp alone would have quietly stored 10 where 19 was meant.
> And `create or replace` cannot change a `RETURNS TABLE`, so `tiles_for_me` and
> `admin_list_tiles` were dropped and rebuilt — grants re-applied in the same
> migration, and verified afterwards (`authenticated` yes, `anon` no).

### One more native dialog, found late

`ActiveTiles` line 39 called a **bare `confirm(...)`**, which the earlier sweep
for `window.confirm` missed. It only sat on the rescue-fire path, so it was not
what blocked the player loop, but it was the same silent failure. Now on the
in-app dialog with the rest. The sweep to use is:

```bash
grep -rnE '(^|[^.a-zA-Z_$])(confirm|alert|prompt)\s*\(' web/src/
```

---

## Session log — 2026-08-31, a ship that sank twice and not at all

Boris read the activity feed and caught it: *"Demo Alpha sank a 4-tile ship"*
after a hit on F2, when the ship was five tiles and did not finish until D2.

He was right on both counts, and the cause was in the schema rather than the
display.

### What happened

`ship_status` decided `sunk` as `count(hits) = ships.size`. In the scratch game
one Bravo ship occupied **five** cells while its `size` column said **four**
(and its neighbour said five while occupying four -- the two were swapped).

So on the fourth hit the count reached four, `4 = 4`, and the ship was announced
sunk, reporting `size: 4`. On the fifth hit the count reached five, `5 = 4` was
false, and the ship silently **un-sank**: no second event, and `sunk` reading
false with every cell of it destroyed.

Three weaknesses had to line up, and all three are worth naming:

1. **`sunk` trusted a denormalised column** instead of the cells sitting right
   there to be counted.
2. **It compared with `=`.** Equality lets a sink reverse itself the moment the
   count passes the size. A threshold cannot.
3. **It counted `tile_claims` rows, not distinct cells.** Two fired hit-claims
   on one square -- which nothing in the schema forbids -- would have sunk a
   ship early on its own, with no corrupt data needed at all.

### Where the bad data came from — not the app

`place_fleet` **cannot** produce this. It derives the size from
`jsonb_array_length(cells)`, raises if the caller's declared size disagrees, and
stores the derived value. Every other fleet in the database is consistent; only
that one Bravo fleet was wrong, in the same scratch game that already carried
hand-written `fired_at` values and invented uploader names. It was edited
directly with service-role access.

That makes the schema fix the point, not the data fix: a win condition should
not rest on "the number is right because the only writer keeps it right".

### The fix (0026)

`sunk` is now `count(distinct hit cells) >= count(distinct cells)`, and the
`size` the view reports is the true cell count, so a wrong `ships.size` can no
longer say anything about a game. `fire_tile` reads the sunk flag and the size
from **one** `ship_status` row, so the announcement cannot disagree with the
decision. `assert_fleets_consistent()` is called from `start_game`, which is the
last moment anyone looks at a board before it counts for something.

**Verified on the live database.** After the migration the ship reads size 5,
hits 5, sunk true. Then, in a rolled-back transaction, D2 was returned to
unfired and re-fired: `shot_fired` hit at position 14, immediately followed by
`ship_sunk` with **`size: 5`**. Under the old logic that replay produced a sink
*before* D2 and no event *at* D2, which is precisely the reported symptom.

### Two leftovers in the scratch game

- **The stale feed rows.** The false "sank a 4-tile ship" at F2 is still in
  `game_events`, and the correct sinking at D2 was never recorded. The game
  *state* is right (the ship reads sunk); only the history is wrong. Left alone
  rather than rewritten, since editing an event log to look tidier is a habit
  worth not starting.
- **`ships.size` is still 4 and 5 on those two ships.** Cosmetic now -- nothing
  reads it for game logic -- but `assert_fleets_consistent` will refuse to start
  that game if it is ever reset to placement, which is the intended behaviour
  and not a bug to chase. The repair statement is at the bottom of 0026 and is a
  no-op on a clean database; it could not run here because
  `freeze_fleet_after_placement` correctly rejects writes to `ships` while a
  game is active. Reset that game to placement and the same statement works, or
  simply re-place Bravo's fleet through the UI, which writes correct sizes.

---

## Session log — 2026-09-01, a simulated match, and the win it gave away

The first full game-to-a-winner this project has ever played. Driven from SQL
rather than a browser, but through the real RPCs with `auth.uid()` set to real
accounts, and every write inside a transaction that was rolled back — nothing
was persisted to Demo Match or the scratch game.

**Game one, played to a result.** Create → 100 tiles (1–3 evidence each, nine
flagged early) → roster → both fleets placed by their captains → start → **47
lock-ins and 47 shots** → Alpha wins 17–12. Both completion routes exercised,
and a plain member uploading against the captain's locked-in tile.

Everything held. Every shot result matched the ground-truth fleet position; no
premature fires; zero tiles left fully evidenced but still active; `ship_status`
sizes matched actual cell counts on all ten ships; eight `ship_sunk` events for
eight sunk ships; one `tile_claimed` and one `shot_fired` per claim; both scores
equalled the true hit count; no coordinates anywhere in the feed. Every guard
refused what it should: non-captain placement, touching ships, off-grid ships,
wrong fleet sizes, starting with a fleet missing, a non-admin starting,
placement once active, a third concurrent lock-in, the opponent evidencing our
tile, a mismatched evidence path, early completion on a single-route tile,
re-firing, and evidence on a fired tile.

**The two secrets held, tested as a real `authenticated` role with RLS live**
rather than as the service role: direct reads of `tiles`, the enemy `ships`,
`ship_cells`, enemy `ship_status` and enemy evidence all returned **0 rows**,
and `tiles_for_me` returned 100 rows, 100 distinct positions, revealing exactly
17 names against 17 lock-ins.

### The bug: the losing team could take the win

`claim_tile` checks the game is `active`. `fire_tile` never did. So a tile
locked in *before* the match ended stayed fireable afterwards, through all three
routes — `add_evidence`, `complete_tile_early`, and the rescue Fire button — and
the winner update ran unconditionally, overwriting whoever had already won.

Reproduced deliberately: Bravo was left one cell short, holding an open lock-in.
Alpha completed its hunt and won. Bravo then submitted the evidence it had
already been working on:

```
before:  status=finished  winner=Sim Alpha
after:   status=finished  winner=Sim Bravo
```

Two `game_won` events, and a 17–17 scoreboard.

Not a corner case. Each team may hold two open tiles, so both sides are nearly
always carrying live ones at the moment somebody wins — and `ActiveTiles` was
rendered in **every** status, upload controls and all. A team finishing an
upload ten seconds after losing rewrote the result, with nobody doing anything
unusual.

**Fixed by 0027 plus one frontend gate.** The guard goes in `fire_tile`, which
all three routes funnel through; `add_evidence` and `complete_tile_early` check
too, so a team that is too late is told before it uploads rather than after; and
the winner update is narrowed to `where id = ... and status = 'active'`, with
the `game_won` event moved inside `if found` so it cannot fire twice.
`ActiveTiles` is now hidden once the game is `finished`.

Verified by replaying the same scenario against the live database, rolled back:
all three routes refused, ordinary play unaffected (16 hits landed normally
first), the winner unchanged, and exactly one `game_won` event.

> **Trap.** The bug needed *two* things to be true, and only one of them was in
> the RPC. The server let the shot through, and the client kept offering it.
> Either alone would have been survivable; together they made a lost game
> winnable by carrying on as normal. Worth remembering when reading a guard:
> ask what the page is still showing, not only what the function permits.

### Vocabulary: lock in, and preparation

On Boris's instruction, players no longer "claim" a tile — they **lock in** a
tile — and the phase before the game is **preparation**, not placement.

This is a rename of the words, not of the schema. `tile_claims`, `claim_tile`,
`tile_claimed` and the `placement` value of `game_status` are all unchanged,
because renaming an enum value would break every `= 'placement'` comparison in
the PL/pgSQL guards at once — `place_fleet`, `start_game`, `admin_set_tiles`,
`admin_open_placement`, `admin_reset_game` and both freeze triggers — and the
architecture is frozen until the event is over.

`lib/status.js` holds the one translation, `statusLabel()`, and every screen
that prints a raw status goes through it, so the two cannot drift. Comments that
describe what a *player* does now say "lock in"; comments naming a database
object still say claim, because that is still its name.

If the schema rename is ever wanted, it is a single migration renaming the enum
value and rewriting the seven function bodies that compare against it, plus a
coordinated frontend deploy — and it should not be attempted with an event
approaching.

### Still not verified

- **The fix in a browser.** 0027 is applied and the gate is committed, but as
  with everything else here, no player session has been driven through it.
- Everything already on the "not verified" list above: a real handset, touch
  fleet placement, and a full game played by two actual people.
