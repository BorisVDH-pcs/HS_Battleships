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
catalogue entry it uses carries the tag **`Battleships V4`**, which is what
`admin_autofill_board` selects on — so the board can be rebuilt on another game
from the tag alone.

The board squares are **snapshots**, not links: `tiles` / `tile_options` are
copied from `tile_library` / `tile_library_options` at placement time and do not
follow later catalogue edits. Changing a drop list means updating both, and the
`library_id` column is how you find the squares to update.

## What is left

1. **Test in the live game** — claim a tile, submit against each rule, and
   confirm the shot fires only when it should. `points_per_set` has been proved
   against `claim_is_complete()` in a rolled-back transaction but has never been
   exercised through the real `add_evidence` path by a player.
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
