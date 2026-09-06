# HS_Battleships — UI/UX review

Reviewed 2026-09-06 against `web/src` at commit 5965d8b. Four surfaces: login,
admin panel, board creator, player interface. Grouped by severity within each.

Legend: **[bug]** something is wrong today · **[gap]** something missing that
the event will need · **[polish]** worth doing, not urgent.

---

## 1. Login page (`components/Login.jsx`, `lib/auth.js`)

### [bug] Two different usernames can collide silently
`usernameToEmail` lowercases, turns spaces into underscores and strips
everything else. `Boris V`, `boris_v` and `BORIS  V` all resolve to the same
account. The second person to sign up gets "That username is taken" while
looking at a name that matches nobody on the roster.

**Fix:** show the derived handle live under the field — *"You'll sign in as
`boris_v`"* — and check availability before submit rather than on the round
trip.

### [gap] Password reset has no path anywhere in the product
The copy says "ask an admin to set a new one", but there is no admin UI for it
(the README sends you to the Supabase dashboard) and no way to reach an admin
from this screen.

**Fix:** either add an admin reset action (see Admin §3), or name the actual
route in the copy — *"post in #battleships-help and an organiser will reset
it"*. A dead end on the login screen is the worst place to have one.

### [gap] No confirm field, no reveal toggle, no caps-lock hint on sign-up
A typo in the sign-up password creates an account nobody can get into, and
there is no self-service reset. This is the one form in the app where a typo
is unrecoverable.

**Fix:** a confirm field on sign-up only, plus a show/hide toggle. Cheap, and
it removes most of the reset requests that the item above has no answer for.

### [bug] Errors are not announced
`<p className="message">` (Login.jsx:91) has no `role="alert"` or `aria-live`.
A screen-reader user, or anyone zoomed past the message, submits and gets
nothing.

**Fix:** `role="alert"` on the message paragraph.

### [polish] The button says "…" for both modes
`{busy ? '…' : …}`. Make it "Signing in…" / "Creating account…" — it is the
only feedback that the press registered.

### [polish] Rate-limit errors come through raw
`friendlyAuthError` maps five cases but not Supabase's throttle
(`over_request_rate_limit` / "too many requests"), which is exactly what forty
people signing up at once will hit.

### [polish] Nothing says what the site is
A player following a Discord link sees a wordmark and two fields. One line
under the wordmark — *"Team-vs-team Battleships on a 100-tile OSRS task grid.
Sign in with your RSN."* — answers "is this the right link" before they type.

---

## 2. Admin panel (`components/Admin.jsx`)

The setup checklist is the best thing in the app — it is a runbook rendered as
state, and it is the reason a game cannot reach Start half-built. Everything
below is around it, not against it.

### [bug] Every action refetches the entire console
`run()` calls `loadGames()` + `loadGameDetail()` + `loadLibrary()` after every
single action — seven queries. In the board builder that is one square placed =
seven queries, so building a 100-tile board is around 700 round trips, each one
re-rendering the whole grid.

**Fix:** let `run` take which slices to refresh (`run(fn, msg, { refresh:
['tiles'] })`), or patch the placed tile into `tiles` optimistically and only
reconcile on error.

### [gap] The roster picker does not scale
`<select>` listing every non-admin profile, no search (Admin.jsx, `Roster`). At
sixty sign-ups that is a scroll through sixty RSNs, twice, with no way to see
who has signed up but landed on no team — which is the actual question an
organiser has the night before.

**Fix:** a type-to-filter combobox, plus an "unassigned players" list above the
two columns.

### [gap] No account management at all
No password reset, no rename, no way to merge the duplicate account someone
made because of the collision in Login §1. This is the most likely event-day
support request and it currently requires the Supabase dashboard.

**Fix:** an `admin_reset_password` RPC and a button per roster row.

### [gap] Readiness is invisible from the Games list
The checklist only exists inside Configure. The Games list shows name, status
and team names — so with three games queued you have to open each one to see
which is ready.

**Fix:** reuse `blocking.length` as a badge on each row in the Games list.

### [gap] No audit trail
`claim_released` writes an event naming an admin, but deletes, resets and tile
edits write nothing. With two organisers, "who reset the game" has no answer.

### [polish] Success and failure look structurally identical
`error` is a red paragraph, `notice` is a `muted` paragraph, same place, same
shape. Only colour separates "saved" from "refused" — the one distinction that
should never rest on hue alone.

**Fix:** give the notice a ✓ and the error a ✗, matching the checklist's own
convention.

### [polish] "Reset, keep fleets" is a ghost button beside a danger one
Both wipe every shot and the whole feed. The weights say one is safer than the
other; it is not.

### [polish] The Tiles paste box is five paragraphs of syntax
The format reference (points, sets, `each`, value targets, `::` notes) is
longer than everything else in the pane. It is good documentation in a bad
place, now that the board builder is the main path.

**Fix:** collapse it behind a "Format help" disclosure, open by default only
when the box is empty.

### [gap] Track answers "what happened", not "what is stuck"
Boards and evidence are there; time since last shot, which team is sitting on
idle slots, and how long a slot has been held are not. Those are what an
organiser nudges people about mid-event.

---

## 3. Board creator (`components/BoardBuilder.jsx`)

Genuinely good: every click is a write, so a half-built board survives a closed
tab and two organisers can split it. The auto-advance to the next empty square
is the right default.

### [gap] Placing a duplicate says nothing
`adminAutofillBoard` reports how many tiles repeat a task, but clicking a
catalogue entry onto a second square is silent. On a 100-square board built
over an evening, that is how the same task ends up on B4 and H9.

**Fix:** badge already-placed entries in the library list — *"on B4"* — and
grey them, the way the set-rule picker already greys spent options.

### [gap] No keyboard navigation
100 squares, tab-only. Arrow keys to move the selection and Enter to open the
panel would roughly halve the time to fill a board.

### [gap] No undo
Every click is a write by design, which is right — but the only way back from a
misplaced tile is Clear square, then re-pick. A single-level "undo last square"
costs one stored `{row, col, previousTile}`.

### [polish] Search does not rank
`matches` filters and preserves the catalogue's most-used-first order, so
typing an exact tile name does not float it to the top. Sort exact match, then
prefix match, then the rest.

### [gap] No way to see the board as a player will
The builder grid shows names; the players see icons at cell size. There is no
toggle to check that the artwork actually reads before the game starts.

### [gap] No sense of whether the board is balanced
100 squares and no summary of what is on them: no histogram by tag, no counts
by completion rule, no spread of required effort. That review happens today by
reading a hundred cells.

**Fix:** a summary strip above the grid — counts by rule, top tags, how many
squares need more than one screenshot.

### [polish] Tags fragment silently
Tags are a comma string in the tile form with no rename or merge, so `boss` and
`bosses` become two filters and neither is complete.

### [polish] The catalogue list renders every row
No virtualisation. Fine at 100 entries, not at 500.

---

## 4. Player interface (`App.jsx` + board components)

### [bug] A dropped realtime socket freezes the board silently
`useGame`'s channel calls `.subscribe()` with no status callback, and nothing
refetches game state on `visibilitychange` — App's focus listener only calls
`loadGames()` (the roster), and the 10s poll only runs in the waiting room. So
a player whose socket drops mid-event sees a board that looks correct and is
not, with no recovery short of a manual reload.

**This is the most consequential item in the review.** During a live event, on
phone wifi, sockets drop.

**Fix:** three parts — pass a status callback to `.subscribe()` and `load()` on
`SUBSCRIBED`; add a `visibilitychange`/`focus` refetch of the game the way the
roster already has; and show a small "reconnecting…" pill so a stale board is
never mistaken for a quiet one.

### [bug] The guide states the wrong number of slots
`Guide.jsx` hardcodes *"currently **three**"* active tiles. `App.jsx` reads
`max_active_tiles ?? 2` and the README says two. Read it from the game and
interpolate it.

### [bug] The fleet-placement tour step targets an element that isn't there
`fleet-placer-section` only renders during preparation, so during an active
game that step shows its card with no highlight and nothing to look at.

**Fix:** filter `TOUR_STEPS` by game phase before rendering the tour.

### [bug] The score is optional, and can be switched off
`Scoreboard.jsx` exists but is imported nowhere — the score now only appears as
the "Hits" row inside `StatsPanel`, and that row is behind a per-browser
checkbox. A player can turn off the score.

**Fix:** decide one way — either delete the dead component, or put the score
back as a fixed element that the stats settings cannot hide.

### [gap] No sound control
`FireEffect` plays a cannon on every shot by *either* team, plus a hit/miss
sound, with no mute and no volume. Someone with the tab open at work gets
ambushed by a cannon. The gif also plays regardless of `prefers-reduced-motion`,
which the stylesheet otherwise respects carefully.

**Fix:** a mute toggle in the header, persisted in localStorage; skip the gif
under `prefers-reduced-motion`.

### [gap] Nothing says who locked in a tile, or when
`ActiveTiles` shows the task, the progress and the coordinate — not who claimed
it or how long ago. With two slots and a team of ten, "who is sitting on this
and are they still on it" is the single most common coordination question, and
the UI cannot answer it. The data is there — claims are attributed.

**Fix:** a line on each slot card — *"locked in by Boris, 40 min ago"*.

### [gap] No list view of tiles the team has revealed
After forty claims, remembering which task was on which square means clicking
squares one at a time. A "tiles we've seen" list — name, coordinate, result —
alongside the grid would be read constantly.

### [gap] The enemy grid is not a grid semantically
100 `<button>`s with no `role="grid"`/`gridcell` and no arrow-key movement. A
screen reader reads "A1 — not yet locked in" a hundred times, and keyboard
users tab through all of it.

**Fix:** `role="grid"` with a roving tabindex.

### [polish] No warning when locking in the last slot
The confirm says it takes one of your slots. It does not say it takes the
*last* one, which is the case where it matters.

### [polish] No "jump to coordinate" on mobile
The 10×10 grid scrolls horizontally on a phone. A small coordinate input, or
tappable axis headers, would beat scrolling to find H7.

### [polish] No team-wide evidence view for players
A player can see evidence per tile, but not "everything our team submitted" —
so checking whether a teammate already handed in a drop means opening squares.

---

## Cross-cutting

- **No error boundary.** A render error anywhere blanks the page for the rest
  of the event. One boundary around `<main>` with a reload button is an hour's
  work and the cheapest insurance here.
- **`Scoreboard.jsx` is dead code** — see Player §4.
- **`prefers-reduced-motion` is handled in CSS but not in JS** — the cannon gif
  and the shot-result animation are JS-driven and ignore it.

---

## If you only do five things

1. Realtime reconnect + staleness pill (Player §1) — silent stale boards during
   a live event.
2. Sign-up confirm field + admin password reset (Login §3, Admin §3) — closes
   the one unrecoverable dead end.
3. Fix the guide's slot count and the phantom tour step (Player §2, §3) — the
   guide currently teaches a rule the game does not use.
4. Scoped refresh in `run()` (Admin §1) — makes board building usable.
5. Claimed-by and claimed-at on the active slot cards (Player §6) — the missing
   half of team coordination.
