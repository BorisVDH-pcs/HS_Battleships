# V4 tile rules — handover

Updated 2026-09-06. No tile text here: this repo is public and the tile list is
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
| `value` | submitter types what each drop was worth; the total reaches the target |

`claim_is_complete()` is the single authority — the table trigger and
`add_evidence` both call it, so they cannot drift.

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

**Icons.** 103 in `web/public/icons`. Twelve added from the wiki this session.
Every named V4 tile has one mapped.

**Admin parser and private generator.** The paste box now reads all four rule
forms and reports line-numbered errors before it calls the database. The private
generator imports that same parser and refuses to write an invalid board. All
100 generated lines validate: 90 points, 3 one-set, 5 each-set and 2 value
tiles. The ten tiles which needed 0049 have been rewritten.

**Local verification.** `npm run test:tile-rules` exercises the paste grammar,
all completion calculations and activity-feed wording. The private generator
validates the entire board with the real parser, and `npm run build` completes.
The migrations have been reviewed against the calling code but have not been
executed against a database.

## What is left

1. **Merge to main.** Merging triggers `db-push`, which applies 0048 and 0049
   to production. Neither migration has been run against a database.
2. **Load the generated board** from the private paste file through the admin
   screen.
3. **Test in the live game** — claim a tile, submit against each rule, and
   confirm the shot fires only when it should.

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
