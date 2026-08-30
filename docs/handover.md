# Handover — HS_Battleships

State of the project as of **2026-08-30**. Written to be picked up cold, by
Boris or by another session.

---

## What this is

An OSRS clan Battleships game, rebuilt from three Google Sheets + Apps Script
into a database-backed web app. Two teams, one shared 100-tile task grid, each
team hiding a fleet of `2,3,3,4,5` on its own 10x10 board.

- **Repo:** https://github.com/BorisVDH-pcs/HS_Battleships
- **Live:** https://borisvdh-pcs.github.io/HS_Battleships/
- **Supabase project:** `Battleships` — `fjgcijmdxeebgkdokini`, eu-west-2
  (deliberately separate from HighSocietyScape's `PProject`, which has colliding
  `teams` / `team_members` tables)
- **Dev server:** port **5174** (`npm run dev --prefix web`), so it can run
  alongside HighSocietyScape on 5173

Background on the original Sheets version is in
[how-the-spreadsheet-worked.md](how-the-spreadsheet-worked.md); design rationale
in [architecture.md](architecture.md).

---

## The rules that matter (V4)

Changed from the spreadsheet version, on Boris's instruction:

| Rule | Detail |
|---|---|
| No turn order | A team fires again the moment it completes a tile |
| No unlock questions | Picking a tile **is** the move; the Levenshtein answer-matching is gone |
| Two active tiles max | Per team, enforced by trigger (`enforce_active_limit`) |
| Fleets frozen at start | For players, captains and admins alike, enforced by table trigger |
| **Ships may not touch** | Not even diagonally — every ship has a clear cell around it |

---

## Architecture in one paragraph

**Two things must never reach the opposing team: enemy ship placement, and the
contents of tiles that team has not claimed.** Both are enforced by Row Level
Security, not by the UI. Clients have no INSERT/UPDATE/DELETE rights anywhere;
every mutation goes through a `security definer` RPC that validates server-side.
The `tiles` table denies all direct reads and the app reads the `tiles_for_me`
view, which nulls out unclaimed tiles. The `game_events` feed is world-readable
and therefore **must never carry a tile's name or rules** — the tile grid is
shared, so naming a tile would reveal it on the reader's own board.

### Migrations

| File | What it does |
|---|---|
| `0001_init.sql` | Tables, enums, RLS, `tiles_for_me`, `ship_status`, freeze + active-limit triggers |
| `0002_rpc.sql` | `place_fleet`, `start_game`, `claim_tile`, `fire_tile` |
| `0003_harden.sql` | Revokes `anon` EXECUTE; `ship_status` to security_invoker |
| `0004_profile_on_signup.sql` | `handle_new_user()` trigger creating `profiles` from auth metadata |
| `0005_lock_down_trigger_function.sql` | Revokes EXECUTE on the trigger function (was callable as an RPC) |
| `0006_admin_and_ship_spacing.sql` | Admin role + admin RPCs, ship-spacing rule, `start_game` made admin-only |
| `0007_enable_realtime.sql` | Publishes `game_events` — **Realtime did nothing before this** |

All are applied to the live project.

---

## Auth — the unusual part

**Username + password only. No email anywhere.** Supabase Auth keys on email, so
each username maps to a synthetic address:

```
"Lil Sod"  ->  lil_sod@players.hs-battleships.invalid
```

`.invalid` is IANA-reserved so nothing can ever be delivered. Supabase rejects
`.local` as malformed; `.invalid` passes. The mapping lives in
`web/src/lib/auth.js` and is duplicated in the admin SQL — **if you change one,
change both.**

Consequence Boris accepted explicitly: **there is no self-service password
reset.** He resets them by SQL (`supabase/admin/player-accounts.sql`).

> **Required project setting:** Authentication → Sign In / Providers → Email →
> **"Confirm email" OFF**. Otherwise sign-ups fail trying to mail an
> undeliverable address. Accounts created through the admin SQL work either way
> since they set `email_confirmed_at` directly.

### Admin is a separate account, never a flag on a player

An admin can read every tile's task and both fleets. An account that both ran
the event and played in it could see its own team's answers. So:

- `profiles.is_admin`, granted only by SQL; the `profiles_self` policy blocks
  self-promotion
- admin accounts are hidden from the roster picker
- admins get the console only, never the player board

Current admin: **`HS Admin`** (username `hs_admin`). Boris holds the password;
it is not recorded anywhere, including here.

---

## Running an event

All in the app, as `HS Admin`:

1. **New game** — name it and both teams
2. **Tiles** — paste 100 lines in board order, `name | rules` optional
3. **Open placement**
4. **Roster** — add players, set captains (players must have signed up first)
5. **Fleets** — click a hull, click its top-left cell, `R` rotates
6. **Start game** — refuses without 2 teams, 100 tiles and 2 complete fleets

Once active, the Fleets card becomes a live spectator view: one board per team,
its ships plus incoming shots, with sunk/hit counts, updating over Realtime.

---

## Deployment

Push to `main` → GitHub Actions builds → Pages. Source must be **"GitHub
Actions"** (already set).

**No repo secrets are needed.** The Supabase URL and publishable key live in
`web/.env.production`, committed on purpose: Vite inlines every `VITE_*` var
into the public bundle, so they are public the moment the site is served
regardless. RLS is what protects the data.

> **Never put an `sb_secret_` key in that file or in a repo secret.** This
> already happened once — a secret key pasted into the `VITE_SUPABASE_ANON_KEY`
> repo secret overrode the committed key and was published in the bundle. It was
> rotated and the workflow now fails the build on `sb_secret_*` and
> `service_role` JWTs. Secrets of the same name still override the file, which
> is the rotation path.

---

## Known gaps / next steps

Roughly in priority order:

1. **Real tile content.** The 100 tiles from the Middleman sheet's `Tile Data`
   have never been imported. The paste box takes them directly.
2. **Discord relay.** The Apps Script posted picks and completions to Discord.
   `game_events` was designed to drive this (it has a `relayed_at` column for
   exactly this purpose) but nothing consumes it yet. An Edge Function or small
   worker reading unrelayed events is the intended shape.
3. **Rotate the Discord webhook URLs** hardcoded in the old Apps Script files on
   Boris's Desktop. Advised repeatedly, never confirmed done.
4. **Scoring.** `score_events` exists for manual adjustments (the sheet's "+1"
   button) but nothing reads or writes it, and there is no scoreboard.
5. **Captain-facing placement.** `place_fleet` allows a captain, but only the
   admin console calls it — a captain has no UI to place their own fleet.
6. **Delete the demo data** before a real event: the "Demo Match" game and the
   `demo` / `Lil Sod` accounts.
7. **Mobile.** Never tested at phone width; the two-board layout will need it,
   since players will be on their phones during a raid.

---

## Traps for the next session

Things that cost time here, so they don't cost it twice:

- **Realtime needs the publication, not just the subscription.** A channel can
  report `SUBSCRIBED` and still deliver nothing if the table isn't in
  `supabase_realtime`. There is no error. That is what 0007 fixes.
- **`CLOSED` from `.subscribe()` is normal once per mount** under React
  StrictMode in dev — it subscribes, tears down, resubscribes. Only
  `CHANNEL_ERROR` / `TIMED_OUT` are real.
- **`row` and `position` are reserved** in a `RETURNS TABLE` column list. Quote
  them.
- **`RAISE NOTICE` is invisible** through the Supabase MCP tool. Return a value
  instead.
- **`select f(), (subquery)` in one statement** evaluates the subquery against
  the pre-call snapshot, so it looks like the function did nothing. Check in a
  separate statement.
- **Browser click coordinates refer to the last screenshot.** Scrolling via JS
  then clicking by coordinate lands in the wrong place. Take a fresh screenshot
  first, or click by `ref`.
- **The GitHub API rate-limits unauthenticated polling fast** (60/hr). Don't
  poll it in a loop; check the deployed bundle instead.
- **`/repos/…/pages` returns 404 without auth** even when Pages is enabled. It
  is not evidence of anything — fetch the site itself.

---

## Verification already done

So the next session knows what is and isn't proven:

- Ship spacing: rejected orthogonal and diagonal touches, server-side, as a
  signed-in user; a rejected placement leaves the previous fleet intact
- Admin RPCs: all five refuse a non-admin with "Admins only"
- Full event flow: create → 100 tiles → open placement → both fleets → start,
  including `start_game` refusing a half-ready board
- Deleting an active game does not trip the fleet-freeze trigger
- Realtime: fired a shot and watched an untouched page update
- Deployed site: correct bundle, correct key, auth round-trip reaches Supabase

**Not proven:** a full game played through the player UI end-to-end by two real
users since the V4 changes; anything at mobile width.
