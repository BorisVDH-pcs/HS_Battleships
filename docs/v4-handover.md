# V4 tile rules — handover

Updated 2026-09-12. No tile text here: this repo is public and the tile list is
secret #2.

## What is done

**0048 — tile descriptions.** `tiles.description`, claim-gated (a pet jar
preview reveals what a tile *is*, never what it *costs*, and the small print is
cost). Paste format gained `:: explanation` at the end of a line, split off
first so pipes, colons and URLs inside the prose are safe.

**0049 — completion rules.** The one that matters. A weighted tile was a sum
with repeats allowed, which cannot express "one full set" or "one from each of
five bosses" — a sum cannot tell two of the same thing from two different
things. So `tile_options.grp` groups options, an ungrouped option is its own
group, and `tiles.completion` picks the rule:

| rule | finishes when |
|---|---|
| `points` | option points reach the target; repeats count *(pre-0049 behaviour, still the default)* |
| `one_set` | any ONE group is fully collected |
| `each_set` | EVERY group has `per_set` distinct options |
| `points_per_set` | EVERY group has `per_set` points in it; **repeats count** *(added 2026-09-12)* |
| `value` | submitter types what each drop was worth; the total reaches the target |

`claim_is_complete()` is the single authority — the table trigger and
`add_evidence` both call it, so they cannot drift.

### `each_set` vs `points_per_set` — the distinction to keep straight

These two group drops identically and differ in exactly one clause, and picking
the wrong one is the easiest mistake on this board:

- **"two DIFFERENT purples from each raid"** → `each_set`. Two of the same
  purple is one purple; that is the tile.
- **"two uniques from each GWD boss"** → `points_per_set`. Two Bandos
  chestplates *are* two uniques; a team that got them has done what was asked.

`each_set` counts DISTINCT options per group (`count(*) filter (where exists
…)`). `points_per_set` sums the POINTS of the evidence rows, so the same option
submitted twice is worth twice. `points_per_set` also has no `least(per_set,
total)` cap — with repeats counting, a group of one drop can still reach any
target, so capping would finish groups that were not finished.

### Repeat caps — a property of the drop, not of the rule

**20260912210000 — `max_times`.** The challenge tile is a price list with a
target, where every entry also says how often it may count: 2 points up to four
times, 3 up to three, 7 once. Under `points` as it stood repeats were unlimited,
so the cheapest drop was a legitimate route to the whole target on its own —
grind it fifteen times and the tile is done.

That is not a new way of finishing a tile, so it is not a sixth rule. It is a
limit on what one drop may contribute, so it is a nullable column on
`tile_options` / `tile_library_options`. Null is unlimited, which is what every
option already in the database has, so nothing needed re-saving.

- **Enforced twice.** `add_evidence` refuses the over-cap screenshot (the same
  doctrine as a repeat on a set tile: refused, not silently banked — and forced
  anyway, since `tile_evidence.points` cannot hold a zero), and
  `claim_is_complete()` clamps **by rank**, counting the first N rows for a drop
  and ignoring the rest. Not `least(count, max_times) * o.points`: that reaches
  back through `option_id` for *today's* price and would undo 0046's freezing of
  `tile_evidence.points`.
- **It composes.** `points_per_set` gets caps for free; the distinct-set rules
  are unaffected, because a repeat there was already worth nothing.
- **A tile that cannot be finished is refused at save time.**
  `assert_points_cap_reachable()` — and `validateTileRow` in the form — reject a
  tile whose every drop is capped and whose caps sum below the target. One
  uncapped drop on the list makes any target reachable, so it only fires when
  none is. Sibling of the `each_set` group-size check.
- **In the interface.** Two number boxes per drop in the builder (worth, then
  how many times; blank is no limit). For the team, the `?` panel shows `2/4`
  beside a capped drop's price, and the picker greys it out and says *used up*
  once it has run out — rather than offering it, uploading, and being refused a
  round trip later.

### When a price is worth printing

`tileShowsPrices(tile)` — one judgement, asked by the picker, the `?` panel and
the builder's preview of both, because all three used to word it slightly
differently. A price is printed only where the tile's drops are **not all worth
the same single point**.

Twenty-six of the board's forty-one priced tiles list drops that are all worth 1
— "any Inquisitor's piece", "Sarachnis pet or jar". There, points and
screenshots are the same number, the counter already says it, and a column of
"1 pt" repeats the target on every line. On the fifteen mixed tiles every price
stays, the 1s most of all: on I9's list "1 pt" would mean *this is the cheap
one*, and hiding it there would leave a price to be inferred from the absence of
a price. Hence tile-wide, never per-option — the old `points_per_set` rule was
per-option and is now folded into this one.

The `?` panel's capped drops read `2 pts · 0/4`; where the price is hidden the
tally stands alone and says `0/4 used`. `pointsLabel()` handles `1 pt` / `2 pts`.

### Trying a tile out before a team ever sees it

**20260912230000 — the dry run.** A tile's rule only says what it means once
evidence starts arriving, and until now the only way to find out was to put the
square in front of a team — by which point the board is locked. Both
`points_per_set` and the repeat caps shipped having been proved only in a
hand-written transaction nobody but its author ever ran.

`admin_test_tile(tile_id, picks)` takes one entry per screenshot in submission
order, plays them into a throwaway claim, asks `claim_is_complete()` after each,
and reports which submission tipped it over and which were turned away.

**The builder drives it one press at a time.** The first cut staged a batch and
checked it in one go — pick, Add, pick, Add, Test — which answered the question
but asked the reader to think in lists. A player does not experience a tile that
way: they submit one thing, watch the counter move, and submit the next. So
*Test submit* appends a single screenshot and replays the whole session, and the
panel draws the player's own counter line (from `tileProgress`, so it cannot
word it differently from the card), what that press did, and the running
history with refusals struck through. Once the tile fires, the button disables
until *Start over* — a player could not submit into a fired claim either.

Replaying the session on every press rather than holding a claim open between
them is deliberate: a claim that survived across presses would be a real row on
a real board waiting for someone to close the browser on it.

The play-through sits in a block with an `EXCEPTION` clause — a subtransaction —
that ends by raising `HS001` against itself, so every insert is discarded.
PL/pgSQL variables are not database state and survive the unwind, which is what
lets the result be assembled inside and returned outside. Nothing commits, so
Realtime broadcasts nothing and the other team's board never flickers.

It deliberately does **not** call `add_evidence`: that fires the shot on
completion, and `fire_tile` wants ships placed and a game under way, neither of
which is true of a board still being built. So it plays the parts that are about
the *tile* and leaves the parts that are about the *game* alone.

**The preview is the interface, not a description of it.** The session's
simulated row — `replayTile().state`, shaped exactly like a `tiles_for_me()`
row — is held in `PlayerSquarePreview` and handed to the card, the `?` panel and
the drop picker alike, because that is how a real player's three views stay in
step: they are one row. So the panel's sets fill in as you submit, and a
finished group collapses to *"General Graardor — ✓ Done"* in the picker.

Holding that row one level up has a trap, which was duly fallen into:
`PlayerSquarePreview` must be **keyed per square and per tile**, or React reuses
the instance when you click a different square and the new tile inherits the old
one's simulated row — H1 offering a set belonging to the tile tested before it.
`EvidencePreview`'s own `key={tile.id}` resets its picks but cannot reset state
held above it. `shown` also checks the row's id matches the tile, so a stale
session is inert rather than convincing.

Before that, the preview listed every drop unconditionally and was **more
permissive than the interface it previewed** — on H2 you could submit a third
Bandos hilt into a General Graardor that was already full and watch the tile not
move. Which is how **20260912235000** was found.

**20260912235000 — a full group takes no more.** `points_per_set` closed the
group in `unavailableSetOptionIds()` but nowhere in the database, so the browser
was the only thing stopping a third hilt from being banked as a point that
bought nothing. `each_set` already refused this through its group-quota check;
the two rules differ on whether a REPEAT counts, not on whether a finished group
stays open. So the refusal is in `evidence_refusal()` for both, measuring the
group the way each rule measures it — distinct options for `each_set`, banked
points for `points_per_set`.

**`evidence_refusal()`** was extracted from `add_evidence` rather than copied, so
the tester and the real submit path cannot disagree about why a screenshot is
turned away. It also folds in `each_set`'s group quota, which `add_evidence`
never checked itself — it let the table trigger raise. Same message, raised
slightly earlier; the trigger stays as the enforcement, per 0021.

**Two answers, on purpose.** The builder shows the database's verdict *and*
`replayTile()` from `tileProgress.js`, and says so loudly when they differ. A
tester that only asked `tileProgress.js` would be asking the mirror whether the
mirror agrees with itself — the drift this repo has been one careless edit away
from since 0049 is exactly what it needs to catch.

Before `points_per_set` existed, H2 faked it with an extra option per group
("any second Graardor unique (duplicate)"). If you ever see an option like that
again, the tile wants this rule, not another fake option.

**`got` on each option.** `tiles_for_me()` returns both `taken` (a boolean: has
this team handed this in at all) and `got` (how many times). The boolean cannot
say "two chestplates", so `points_per_set` needs the count — to draw a group as
2/2 on the card and to know when to close it in the picker.

**UI.** `TileInfo.jsx` is the "?" beside a tile name: hover peeks, click pins,
Escape or an outside click dismisses. It shows the description, and the drop
list grouped into sets with a tick on what is already handed in. Portaled to
`<body>` — the active-tile column is a `backdrop-filter` material, which makes
it the containing block for `position: fixed` children *and* its own stacking
context, so in place the panel measured against the column and painted
underneath the cards. Placement is computed in script because CSS cannot keep a
panel inside the viewport, and the column hugs one edge of the board.

`lib/tileProgress.js` is shared by the card, the picker and the panel so the
counter and the Submit button cannot disagree about whether the next screenshot
fires the shot.

The always-open price list is gone from the card — on a slayer tile it was 38
rows and pushed the drop zone off the bottom of the column.

**Icons.** 274 in `web/public/icons`. `web/src/lib/icons.js` is GENERATED from
that directory — add the `.png`, then run `npm run icons:manifest --prefix web`
and commit both. Never hand-edit `icons.js`.

A tile whose `icon` is null renders the `dragon_warhammer` placeholder
(`TileIcon.jsx`), which is deliberate for genuinely-undrawn tiles and looks like
a bug on a tile that simply has no art yet. For wiki artwork, prefer the
`File:X detail.png` variant — the plain `File:X.png` is a small inline sprite,
and this repo's icons fill a 64x64 canvas nearly edge to edge.

**How a board gets built.** Through the **board builder** (`BoardBuilder.jsx`),
square by square, against the tile catalogue (`tile_library` /
`tile_library_options`). The paste box, its grammar, `parseTileText` and
`admin_set_tiles` are all **gone** — the builder is the only route now, and
`tileParser.js` survives only as `validateTileRow`, which the form calls.

The builder also has a **"See it as a player does"** preview: the real
`TileInfo` "?" panel and a live, browsable copy of the evidence dropdown, so a
drop list can be proofread without claiming the tile. The dropdown is
deliberately pickable but inert — no submit path, and it resets per square.

**Local verification.** `npm run test:tile-rules --prefix web` covers every
completion calculation, the tiles a rule refuses to describe, and activity-feed
wording. `npm run test:tile-draft --prefix web` round-trips a database row
through the form's draft shape and back, for every rule. Both must pass; both
were silently broken between 2026-09-12's paste-box removal and its
points_per_set commit, because they still imported the deleted `parseTileText`.

**0052 — early completion removed.** `early_complete` existed for one reason
(0025): a tile with several routes at different prices could only be counted in
screenshots, so it was priced at its worst case and the team got a self-declared
*Complete Early* button. 0046 and 0049 took that reason away — a multi-route tile
is priced drops, a set tile is `one_set` or `each_set`, a GP tile is `value`, and
each says exactly when it is done. 0046 then refused the button on priced tiles
and 0049 on the set and value rules, which left it reachable only on a plain
"N screenshots" tile — the single-route case 0025 said must never have it. None
of the 100 generated lines is flagged, and production has never recorded a claim
declared early. Nine tiles on the 2026-08-30 demo board still carry the flag,
along with the four catalogue entries imported from it; they revert to the plain
worst-case count they were always priced at.

So it is gone: `complete_tile_early()`, the trigger's second route to `fired`,
`tiles.early_complete`, `tile_claims.completed_early` (never read by anything),
`tile_library.early_complete`, the `+` in the paste grammar, the checkbox in the
tile form, the badge on the admin board, the guide step and the button on the
card. `enforce_evidence_before_fire` is back to one route through it:
`claim_is_complete()` agreed, or the claim does not become `fired`.

## The V4 board itself

Built on the **Test** game, 100 squares, row-major (A1→J1, A2→J2, …). Every
catalogue entry it uses carries the tag **`Battleships V4`** — 86 of them.

> **Correction.** This section used to say the board could be rebuilt on another
> game from the tag alone. It cannot, and could not once the repeats went in.
> `admin_autofill_board` cannot place the same tile twice, and this board spends
> **18 squares on 4 repeated tiles** (`15 Slayer Points` ×10, `Four different
> raids purples` ×4, `3 Maggot King Uniques` ×2, `5 Colosseum Uniques` ×2). An
> 86-entry pool into 100 squares also leaves 14 short, and `start_game` refuses
> a board that is not exactly `grid_size²`. Autofill deals a *first draft*; it
> does not reproduce a finished board.
>
> Saved boards (20260913000000) are what reproduce one. The V4 board is saved as
> the preset **`Battleships V4`**.

The board squares are **snapshots**, not links: `tiles` / `tile_options` are
copied from `tile_library` / `tile_library_options` at placement time and do not
follow later catalogue edits. Changing a drop list means updating both, and the
`library_id` column is how you find the squares to update.

## What is left

1. **Test in the live game** — claim a tile, submit against each rule, and
   confirm the shot fires only when it should. `points_per_set` has been proved
   against `claim_is_complete()` in a rolled-back transaction but has never been
   exercised through the real `add_evidence` path by a player. The same is now
   true of repeat caps: fifteen fire capes were proved to be worth 8 and not 30,
   and a second Awakened Vard worth nothing, but `add_evidence`'s refusal
   message has not been seen by anyone, and neither has the builder's second
   number box or the picker's *used up*.
2. **Nothing has been checked on a real phone.**

## Decisions already taken (do not re-ask)

- Coordinate prefixes (`D1.`) are stripped from tile names; the board draws the
  coordinate already.
- The sheet's "Options" column is the *explanation*, not options.
- The `Slayer item | Points` table on the right of the sheet is the option list
  for the ten "10 Slayer Points" tiles, target 10.
- Targets come from the number in the tile name; value-based and multi-route
  tiles were resolved individually with Boris.
- A full Barrows set is 4 pieces (weapon + helm + body + legs), 6 sets.
  A full Moons set is 4 (armour + weapon), 3 sets.
- 16 squares had no tile in the sheet and load as clearly-marked TBD.
- Revenant artefacts use integer-million weights 1 / 2 / 4 / 8 / 16. The 0.5m
  Ancient emblem is excluded rather than rounded.
- A tile named "N <boss> uniques" gets a drop list under `points`, 1 point each,
  repeats counting. A tile named "two uniques from **each** <boss>" gets
  `points_per_set`. A tile that says **different** gets `each_set`.
- Drop lists are checked against the OSRS wiki, not recalled. An earlier session
  put Skull of Vet'ion on the Dagannoth Kings list from memory and was corrected;
  the wiki's own page, or `api.php?action=parse&prop=wikitext`, is the source.
  WebFetch summaries of long drop tables have also come back wrong — read the
  wikitext when the answer matters.
