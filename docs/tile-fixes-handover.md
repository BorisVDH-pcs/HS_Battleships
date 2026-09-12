# Handover — tile fixes and the half million

Written 2026-09-13, mid-job, because the session ran out of budget. Everything
below is either **done and live**, **parked on a branch**, or **not started**,
and it says which. Nothing is half-applied to the database.

## State of things

| | |
|---|---|
| `main` | `a58867a` — builds, deploys, correct |
| branch `value-in-tenths` | `a0726ba` — client half of the value change, **must not merge until the migration below exists** |
| database | consistent with `main`. No migration from the unfinished work was applied |
| board `Test` | 100 squares, intact. Shuffled twice during verification, so the *layout* differs from before; the tiles are all still on it |

### Shipped this session

- `admin_shuffle_board()` + **Shuffle the N tiles on the board** — permutes the
  tiles already on a board instead of re-dealing. Migration
  `20260913020000_shuffle_board.sql`, applied and recorded.
- **Randomize** (was "Re-deal from the catalogue") and its dialog, which now
  predicts how many squares a label can actually fill.
- Tag field relabelled **Include only tiles labelled**.

### Not started — the five squares the user asked for

**None of these edits were made.** The research behind them is done and is
below, so picking this up should not need the wiki again.

## 1. The five squares

Coordinates are as of the board *after* the shuffles; check the tile **name**,
not the square, before editing.

### E7 — "One Teamcape from easies" (`points`, target 1, no drops)
Add three drops, 1 pt each, no group, no cap. Any one finishes it, which is
what target 1 already says.

- `Team cape zero`
- `Team cape i`
- `Team cape x`

The description already says the Cape of skulls does not count. Leave it.

### E6 — "Avernic Treads or Dom" (`points`, target 1, no drops)
Add two drops, 1 pt each.

- `Avernic treads`
- `Dom`

Both are Yama drops. `Dom` is the pet — worth confirming the spelling against
the wiki if it looks wrong on screen, it was not separately checked.

### G5 — "Two Different GWD Weapons" (`each_set`, per_set 2)
**Do not just add the fifth drop.** See §2 — this tile is one of the seven with
the grouping fault, and adding a drop while it is ungrouped makes it require
five weapons instead of four.

Fix in one edit: put every drop in a single group (suggested name
`GWD weapons`), add the new one, and leave per_set at 2.

- `Zamorakian spear`, `Steam battlestaff`, `Armadyl crossbow`,
  `Saradomin sword`, **`Staff of the dead`** (new)

Also append Staff of the dead to the description, which currently reads
"Zammy spear, steam battlestaff, ACB, sara sword count. A hilt isnt a weapon."

### J2 — "3 CM or HMT Kits/Dusts" (`points`, target 3, no drops)
The user asked for three and there are **five**. Confirmed on the wiki, and the
choice of all five was agreed:

| drop | from |
|---|---|
| `Twisted ancestral colour kit` | CoX Challenge Mode, 1/75 |
| `Metamorphic dust` | CoX Challenge Mode, 1/400 |
| `Sanguine dust` | ToB Hard Mode, 1/275 |
| `Sanguine ornament kit` | ToB Hard Mode, 1/150 |
| `Holy ornament kit` | ToB Hard Mode, 1/100 |

1 pt each, no group. Leave them **uncapped**: the tile asks for three of them,
not three different ones, and two of the same kit is a real outcome.

### G2 — "15M worth of Revenant emblems"
Currently `points`, target 15, with the artefacts priced in millions
(totem 1, statuette 2, medallion 4, effigy 8, relic 16) and a description that
excludes the Ancient emblem because it is worth 0.5m and points are integers.

**Decided:** convert to the `value` rule, target 15m, no drop list — the team
types what each artefact was worth. This is what the parked branch is for.

Wiki-confirmed values: emblem **500,000** exactly (Emblem Trader; GE ~498k),
totem 1m, statuette 2m, medallion 4m, effigy 8m, relic 16m.

The drop list is lost in the conversion (a value tile may not have one), so the
tiers belong in the description instead — something like:

> Type what each artefact was worth. Emblem 0.5, totem 1, statuette 2,
> medallion 4, effigy 8, relic 16.

## 2. Seven tiles that ask for more than they say

An `each_set` option with no `grp` becomes **a group of its own**, and the rule
requires every group to be satisfied — so an ungrouped `each_set` tile demands
*one of every drop on the list*. The server does this in `claim_is_complete()`
(`group by coalesce(o.grp, o.label)`) and `tileProgress.js` mirrors it, so the
card and the database agree with each other and both are wrong about the intent.

| tile | says | actually requires |
|---|---|---|
| Two Different GWD Weapons | 2 | all 4 |
| Two Different Doom Uniques | 2 | all 4 |
| Two Different Nightmare Uniques | 2 | **all 10** |
| Three Different Common Raids Purples | 3 | all 5 |
| Three Different Mid-tier Raids Purples | 3 | all 7 |
| Three Different Raids Armour Pieces | 3 | all 9 |
| Onyx from 3 Different Sources | 3 | all 6 |

Agreed: **fix all seven.** The fix is to give every drop on the tile the same
group name; `per_set` is already right on each of them.

`Every DKs Unique` and `Every Zulrah Unique` have the same shape and are
**correct** — those really do want all of them. Do not touch them.

The correct pattern already exists in the catalogue to copy from:
`Three Different GWD Armour Pieces` — ten drops, one group, per_set 3.

## 3. Where an edit has to be written

A square is a **snapshot**, not a link (0051). A fix therefore lands in three
places, and this was agreed:

1. the square on the board — `admin_set_tile`;
2. the catalogue entry — `admin_save_library_tile`, or a re-deal brings the
   fault back;
3. the saved preset **Battleships V4** — re-save it afterwards, or loading it
   brings the fault back.

Drive these through the RPCs rather than raw `update` statements, so the guards
and the validation run. To call an admin RPC from the SQL editor, set the
claims in the same statement:

```sql
select set_config('request.jwt.claims',
                  json_build_object('sub', (select id::text from profiles where is_admin order by id limit 1))::text,
                  true),
       admin_set_tile(...);
```

`admin_set_tile` replaces a tile's drops wholesale, which is safe here only
because nothing on `Test` is claimed. On a live board with a claim it is
refused, and rightly — `tile_evidence.option_id` is `on delete set null`.

## 4. The value change, and what is left of it

### Why
`p_amount` was an int in whole millions, so a 500k drop could not be counted at
all. The unit is now a **tenth of a million** for value tiles everywhere:
`p_amount`, `tile_evidence.points`, and `required_evidence` on `tiles` and
`tile_library`. 0.5m is `5`, 15m is `150`, 250m is `2500`. Nothing stored is a
fraction and nothing player-facing changes, because every screen divides back.

### Done, on branch `value-in-tenths`
- `web/src/lib/millions.js` — the unit, in one place. Parses `0,5` and `0.5`
  (a decimal comma through `parseFloat` silently reads `0`, which would eat a
  real drop), refuses two decimal places rather than rounding.
- `tileProgress.js` — divides for display, decides `done` on the integers.
- `EvidenceUploader.jsx`, and the builder's tester — `type="text"` with
  `inputMode="decimal"`, because `type="number"` reports an **empty value** for
  `0,5` in most browsers.
- `tileDraft.js` (`draftFromRow` / `payloadFromDraft` / `ruleSummary`),
  `TileForm.jsx`, `eventText.js`, `AdminOverview.jsx`, `tileParser.js` bounds.
- Both self-tests updated and passing, including `0,5` round-tripping.

### Left to do — the migration, `20260913040000_value_in_tenths.sql`
Nothing of this is applied. Assemble it by copying each function from the
migration that currently defines it and changing only the marked line:

1. **`value_m(int) returns text`** — new helper, tenths to a millions string,
   whole numbers staying whole (`150` → `15`, not `15.0`).
2. **`add_evidence`** — from `20260912230000_tile_dry_run.sql` lines 104–250.
   Change the range check `p_amount < 1 or p_amount > 1000` to `> 10000` and
   the message to "between 0.1m and 1000m".
3. **`discord_line`** — from `20260912184937_points_per_set.sql` lines 262–338.
   Wrap the three numbers in the `v_rule = 'value'` branch in `value_m(...)`.
4. **`admin_set_tile`** — from `20260913010000_edit_unclaimed_tiles_live.sql`
   lines 53–169, and **`admin_save_library_tile`** — from
   `20260912210000_option_repeat_caps.sql` lines 569–653. Both clamp the target
   with `least(greatest(..., 1), 1000)`; that ceiling becomes
   `case when v_completion = 'value' then 10000 else 1000 end`, or a 250m tile
   silently saves as 100m.
5. **The data**, ×10 and once only — not idempotent, so do not re-run by hand:
   - `tiles` and `tile_library` where `completion = 'value'` (3 entries,
     5 squares: `250m In Boss Uniques`, `250m In Raid Uniques`,
     `50m in Clue Loot`);
   - `tile_evidence.points` for evidence against those tiles (3 rows, all on
     `Evidence Demo (scratch)`);
   - the copies inside `board_presets.squares` (JSONB).

Then: apply, record the version in `supabase_migrations.schema_migrations` so
CI's `db push` skips it, merge the branch, and only then convert G2.

A half-applied state is the thing to avoid. The client alone reads every value
tile at a tenth of its target; the migration alone makes a typed `15` arrive as
`15` and score 1.5m.

## 5. Worth knowing

- `gh` is not on PATH in this environment; check Actions in the browser.
- `python` is not on PATH either — `node -e` for scripted edits.
- `web/src/lib/tileParser.js` shows as **binary** to git. It contains a
  deliberate NUL byte used as a dedupe-key joiner and has since well before
  this work. Not a regression; do not "fix" it.
- Pages deploys have been queueing for minutes at a time this week. A build
  that succeeds and a deploy that sits in "Queued" is GitHub, not the commit.
