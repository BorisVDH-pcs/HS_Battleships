# HS_Battleships — UI/UX review

Reviewed 2026-09-06/07 against `web/src` at commit 5965d8b. Four surfaces:
login, admin panel, board creator, player interface. Grouped by severity within
each.

Legend: **[bug]** something is wrong today · **[gap]** something missing that
the event will need · **[polish]** worth doing, not urgent.

47 items. The five worth doing first are at the bottom.

---

## 1. Login page (`components/Login.jsx`, `lib/auth.js`)

### 1.1 [bug] Two different usernames can collide silently
`usernameToEmail` lowercases, turns spaces into underscores and strips
everything else. `Boris V`, `boris_v` and `BORIS  V` all resolve to the same
account. The second person to sign up gets "That username is taken" while
looking at a name that matches nobody on the roster.

**Fix:** show the derived handle live under the field — *"You'll sign in as
`boris_v`"* — and check availability before submit rather than on the round
trip.

### 1.2 [gap] Password reset has no path anywhere in the product
The copy says "ask an admin to set a new one", but there is no admin UI for it
(the README sends you to the Supabase dashboard) and no way to reach an admin
from this screen.

**Fix:** either add an admin reset action (see 2.3), or name the actual route in
the copy — *"post in #battleships-help and an organiser will reset it"*. A dead
end on the login screen is the worst place to have one.

### 1.3 [gap] No confirm field, no reveal toggle, no caps-lock hint on sign-up
A typo in the sign-up password creates an account nobody can get into, and
there is no self-service reset. This is the one form in the app where a typo is
unrecoverable.

**Fix:** a confirm field on sign-up only, plus a show/hide toggle.

### 1.4 [bug] Errors are not announced
`<p className="message">` (Login.jsx:91) has no `role="alert"` or `aria-live`.
A screen-reader user, or anyone zoomed past the message, submits and gets
nothing.

### 1.5 [polish] The button says "…" for both modes
Make it "Signing in…" / "Creating account…" — it is the only feedback that the
press registered.

### 1.6 [polish] Rate-limit errors come through raw
`friendlyAuthError` maps five cases but not Supabase's throttle
(`over_request_rate_limit` / "too many requests"), which is exactly what forty
people signing up at once will hit.

### 1.7 [polish] Nothing says what the site is
A player following a Discord link sees a wordmark and two fields. One line
under the wordmark — *"Team-vs-team Battleships on a 100-tile OSRS task grid.
Sign in with your RSN."* — answers "is this the right link" before they type.

---

## 2. Admin panel (`Admin.jsx`, `AdminOverview.jsx`, `EvidenceReview.jsx`)

The setup checklist is the best thing in the app — a runbook rendered as state,
and the reason a game cannot reach Start half-built. Everything below is around
it, not against it.

### 2.1 [bug] Every action refetches the entire console
`run()` calls `loadGames()` + `loadGameDetail()` + `loadLibrary()` after every
single action — seven queries. In the board builder that is one square placed =
seven queries, so building a 100-tile board is around 700 round trips, each one
re-rendering the whole grid.

**Fix:** let `run` take which slices to refresh (`run(fn, msg, { refresh:
['tiles'] })`), or patch the placed tile into `tiles` optimistically and only
reconcile on error.

### 2.2 [gap] The roster picker does not scale
`<select>` listing every non-admin profile, no search. At sixty sign-ups that is
a scroll through sixty RSNs, twice, with no way to see who has signed up but
landed on no team — which is the actual question an organiser has the night
before.

**Fix:** a type-to-filter combobox, plus an "unassigned players" list above the
two columns.

### 2.3 [gap] No account management at all
No password reset, no rename, no way to merge the duplicate account someone made
because of the collision in 1.1. The most likely event-day support request, and
it requires the Supabase dashboard.

### 2.4 [bug] EvidenceReview signs every URL in the game at once
`EvidencePanel` deliberately mints signed URLs for one tile only, and says why:
they expire, so a panel left open all evening stops showing images.
`EvidenceReview` then does exactly the opposite — it signs the storage path of
every row in the game in one call on mount, and never refreshes them. Left open
through an event, the whole screen goes blank.

**Fix:** page the list and sign per page, with a re-sign on expiry.

### 2.5 [gap] EvidenceReview has no paging, filtering or search
Every screenshot in the game, newest first, in one `<ul>`. Two teams × 100 tiles
× several screenshots is several hundred full-size images rendered at once. And
when a dispute is about one tile, there is no way to filter to it — the screen
exists to settle disputes and cannot be pointed at one.

**Fix:** filter by team, tile and player; page the results.

### 2.6 [gap] Readiness is invisible from the Games list
The checklist only exists inside Configure. The Games list shows name, status
and team names — so with three games queued you open each one to see which is
ready. Reuse `blocking.length` as a badge on each row.

### 2.7 [gap] No audit trail
`claim_released` writes an event naming an admin, but deletes, resets and tile
edits write nothing. With two organisers, "who reset the game" has no answer.

### 2.8 [polish] AdminOverview's realtime failure is a console warning
It does check `.subscribe()` status (unlike the player board — see 4.1), but a
`CHANNEL_ERROR` only reaches `console.warn`. The organiser watching the boards
sees a screen that has quietly stopped updating.

### 2.9 [polish] Success and failure look structurally identical
`error` is a red paragraph, `notice` is a `muted` paragraph, same place, same
shape. Only colour separates "saved" from "refused" — the one distinction that
should never rest on hue alone. Give the notice a ✓ and the error a ✗, matching
the checklist's own convention.

### 2.10 [polish] "Reset, keep fleets" is a ghost button beside a danger one
Both wipe every shot and the whole feed. The weights say one is safer than the
other; it is not.

### 2.11 [polish] The Tiles paste box is five paragraphs of syntax
The format reference (points, sets, `each`, value targets, `::` notes) is longer
than everything else in the pane — good documentation in a bad place now that
the board builder is the main path. Collapse it behind a "Format help"
disclosure, open by default only when the box is empty.

### 2.12 [gap] Track answers "what happened", not "what is stuck"
Boards and evidence are there; time since last shot, which team is sitting on
idle slots, and how long a slot has been held are not. Those are what an
organiser nudges people about mid-event.

### 2.13 [polish] TeamNameEditor's "Saved." never clears
It stays under the field until the team id or name changes. Nothing distinguishes
"just saved" from "saved ten minutes ago".

---

## 3. Board creator (`BoardBuilder.jsx`, `TileForm.jsx`, `IconPicker.jsx`)

Genuinely good: every click is a write, so a half-built board survives a closed
tab and two organisers can split it. The auto-advance to the next empty square
is the right default.

### 3.1 [gap] Placing a duplicate says nothing
`adminAutofillBoard` reports how many tiles repeat a task, but clicking a
catalogue entry onto a second square is silent. On a 100-square board built over
an evening, that is how the same task ends up on B4 and H9.

**Fix:** badge already-placed entries in the library list — *"on B4"* — and grey
them, the way the set-rule picker already greys spent options.

### 3.2 [gap] No keyboard navigation
100 squares, tab-only. Arrow keys to move the selection and Enter to open the
panel would roughly halve the time to fill a board.

### 3.3 [gap] No undo
Every click is a write by design, which is right — but the only way back from a
misplaced tile is Clear square, then re-pick. A single-level "undo last square"
costs one stored `{row, col, previousTile}`.

### 3.4 [gap] No way to see the board as a player will
The builder grid shows names; the players see icons at cell size. There is no
toggle to check that the artwork actually reads before the game starts.

### 3.5 [gap] No sense of whether the board is balanced
100 squares and no summary of what is on them: no histogram by tag, no counts by
completion rule, no spread of required effort. That review happens today by
reading a hundred cells.

**Fix:** a summary strip above the grid — counts by rule, top tags, how many
squares need more than one screenshot.

### 3.6 [polish] Search does not rank
`matches` filters and preserves the catalogue's most-used-first order, so typing
an exact tile name does not float it to the top. Sort exact, then prefix, then
the rest.

### 3.7 [polish] Tags fragment silently
Tags are a comma string in the tile form with no rename or merge, so `boss` and
`bosses` become two filters and neither is complete.

### 3.8 [polish] The catalogue list renders every row
No virtualisation. Fine at 100 entries, not at 500.

### 3.9 [polish] IconPicker renders the whole icon set on an empty query
d0b5dc6 added 144 bosses and 23 skill icons. Opening the picker with no search
term now paints the entire manifest as `<img>` thumbnails, none lazy-loaded.

### 3.10 [polish] No preview of the tile card from the form
`TileForm` edits name, icon, explanation and rule, but you cannot see the slot
card a player will read until the game is running.

---

## 4. Player interface (`App.jsx`, `useGame.js`, board components, `PetJar.jsx`)

### 4.1 [bug] A dropped realtime socket freezes the board silently
`useGame`'s channel calls `.subscribe()` with **no status callback**, and nothing
refetches game state on `visibilitychange` — App's focus listener only calls
`loadGames()` (the roster), and the 10s poll only runs in the waiting room. So a
player whose socket drops mid-event sees a board that looks correct and is not,
with no recovery short of a manual reload.

The same file's sibling already knows better: `AdminOverview` passes a status
callback **and** polls every 20s as a backstop. The player board — the one on a
phone, on event wifi, for four hours — has neither.

**This is the most consequential item in the review.**

**Fix:** pass a status callback to `.subscribe()` and `load()` on `SUBSCRIBED`;
add a `visibilitychange`/`focus` refetch of the game the way the roster already
has; show a "reconnecting…" pill so a stale board is never mistaken for a quiet
one.

### 4.2 [bug] The guide states the wrong number of slots
`Guide.jsx` hardcodes *"currently **three**"* active tiles. `App.jsx` reads
`max_active_tiles ?? 2` and the README says two. Read it from the game.

### 4.3 [bug] The fleet-placement tour step targets an element that isn't there
`fleet-placer-section` only renders during preparation, so during an active game
that step shows its card with no highlight and nothing to look at. Filter
`TOUR_STEPS` by game phase.

### 4.4 [bug] The score is optional, and can be switched off
`Scoreboard.jsx` exists but is imported nowhere — the score now only appears as
the "Hits" row inside `StatsPanel`, and that row is behind a per-browser
checkbox. A player can turn off the score.

**Fix:** either delete the dead component, or put the score back as a fixed
element the stats settings cannot hide.

### 4.5 [bug] PetJar's paste listener is rebound on every render
`useEffect(() => {…})` in `PetJar.jsx` has no dependency array, so the listener
is removed and re-added after every single render of the panel.

### 4.6 [gap] Spending a pet-jar charge asks for no confirmation
Locking in a tile confirms. Firing a shot confirms. Spending a preview
charge — earned from a *pet drop*, irreversible, and gone whether or not the
tile turns out to be worth it — does not. The cheap action guards; the precious
one does not.

### 4.7 [gap] The preview picker is a dropdown of bare coordinates
Up to 100 options reading `A1`, `B1`, `C1`… with the board sitting right there
unusable. You pick blind, from a list, when the natural gesture is clicking the
square.

**Fix:** spend the charge by clicking an unclaimed square on the enemy grid.

### 4.8 [gap] No sound control
`FireEffect` plays a cannon on every shot by *either* team, plus a hit/miss
sound, with no mute and no volume. Someone with the tab open at work gets
ambushed. The gif also plays regardless of `prefers-reduced-motion`, which the
stylesheet otherwise respects carefully.

**Fix:** a mute toggle in the header, persisted in localStorage; skip the gif
under `prefers-reduced-motion`.

### 4.9 [gap] Nothing says who locked in a tile, or when
`ActiveTiles` shows the task, the progress and the coordinate — not who claimed
it or how long ago. With two slots and a team of ten, "who is sitting on this
and are they still on it" is the most common coordination question, and the UI
cannot answer it. The data exists; claims are attributed.

**Fix:** a line on each slot card — *"locked in by Boris, 40 min ago"*.

### 4.10 [gap] No list view of tiles the team has revealed
After forty claims, remembering which task was on which square means clicking
squares one at a time. A "tiles we've seen" list — name, coordinate, result —
alongside the grid would be read constantly.

### 4.11 [gap] The enemy grid is not a grid semantically
100 `<button>`s with no `role="grid"`/`gridcell` and no arrow-key movement. A
screen reader reads "A1 — not yet locked in" a hundred times; keyboard users tab
through all of it.

### 4.12 [polish] TileInfo's panel is a tooltip that behaves like a dialog
`role="tooltip"`, but it pins on click, scrolls internally, holds a
thirty-eight-row price list and dismisses on Escape. Screen readers treat
tooltips as transient and may never reach the list. It is a disclosure.

### 4.13 [polish] PetJar's drop zone has no drag state
`EvidenceUploader` highlights on `dragover` (`.over`); PetJar does not. Two
upload zones on the same page, behaving differently.

### 4.14 [polish] The pet-jar count is a bare number
`<span className="pet-jar-count">{count}</span>` with no label. Nothing on the
panel says what a charge is or what spending one does — that lives only in the
guide.

### 4.15 [polish] The last preview result never clears
`preview` persists in the panel until the component remounts, so a tile you
revealed an hour ago is still sitting there under the drop zone.

### 4.16 [polish] No warning when locking in the last slot
The confirm says it takes one of your slots. It does not say it takes the *last*
one, which is the case where it matters.

### 4.17 [polish] No "jump to coordinate" on mobile
The 10×10 grid scrolls horizontally on a phone. A coordinate input, or tappable
axis headers, would beat scrolling to find H7.

### 4.18 [polish] No team-wide evidence view for players
A player can see evidence per tile, but not "everything our team submitted" — so
checking whether a teammate already handed in a drop means opening squares.

---

## 5. Cross-cutting

### 5.1 [gap] No error boundary
A render error anywhere blanks the page for the rest of the event. One boundary
around `<main>` with a reload button is an hour's work and the cheapest
insurance here.

### 5.2 [polish] `prefers-reduced-motion` is honoured in CSS but not in JS
The cannon gif and the shot-result animation are JS-driven and ignore it.

### 5.3 [polish] Evidence images carry `alt=""`
In both `EvidencePanel` and `EvidenceReview` the screenshot — the entire content
of the row — is marked decorative.

### 5.4 [polish] ConfirmDialog has no focus trap
`role="dialog"`, `aria-modal`, Escape, autofocus and a portal are all correct;
Tab can still walk out of it into the page behind, and focus is not restored to
the trigger on close.

### 5.5 [polish] `Scoreboard.jsx` is dead code
See 4.4.

---

## If you only do five things

1. **4.1** — realtime reconnect + staleness pill. Silent stale boards during a
   live event, and your own admin screen already does it right.
2. **1.3 + 2.3** — sign-up confirm field and an admin password reset. Closes the
   one unrecoverable dead end in the product.
3. **4.2 + 4.3** — the guide teaches a slot count the game does not use, and
   points at a section that isn't on screen.
4. **2.1** — scoped refresh in `run()`. Makes board building usable.
5. **4.9** — claimed-by and claimed-at on the slot cards. The missing half of
   team coordination.
