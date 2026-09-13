# Value tiles in tenths, and the tile fixes of 2026-09-13

All done and applied. Kept because two of the decisions here are the kind that
look arbitrary in six months, and one of them changes what a stored number
means.

## Half a million

A `value` tile is scored on what the submitter types, in millions, and that
number used to be a whole one — `p_amount` was an int and `tile_evidence.points`
is an integer column. "15M worth of Revenant emblems" broke on it: an Ancient
emblem is worth exactly 500,000, so the tile's own description had to exclude
it. That is a rule invented to fit the storage.

**The stored unit for value tiles is now a tenth of a million.** 0.5m is `5`,
15m is `150`, 250m is `2500`.

Nothing anyone types changed. The box still says millions, the card still reads
`190/250m`, Discord still says "a drop worth 250m". The tenths are storage, and
every screen divides back through `web/src/lib/millions.js` or `value_m()` in
SQL. The one visible consequence: read the database by hand and a 250m tile
says `2500`.

Why not a decimal column: `required_evidence` and `points` are shared by all
five completion rules, so every count in the game would become a decimal, and
Postgres hands decimals to the browser as *text* — arithmetic breaks quietly.
Tenths keep the change inside the value rule.

Migration `20260913040000_value_in_tenths.sql` carries the lot: `value_m()`,
the widened range in `add_evidence`, `discord_line` printing through `value_m`,
both save functions choosing a ceiling by rule (without which a 250m tile
clamps to 100m), the column `CHECK`s restated in the new unit, a one-time ×10
of everything already stored, and `admin_test_tile` — which had the *old*
bounds and would have refused an amount the real `add_evidence` accepts.

Both separators are accepted: `0,5` and `0.5`. A decimal comma through
`parseFloat` silently reads `0`, which would eat a real drop, and `type="number"`
reports an *empty value* for `0,5` in most browsers — which is why the player's
box and the builder's tester are both text inputs. `0.55` is refused rather
than rounded.

## An ungrouped `each_set` tile asks for everything

`claim_is_complete()` groups options by `coalesce(o.grp, o.label)`, so an
option with no group **is a group of its own**, and `each_set` needs every
group satisfied. Seven tiles were written without groups and therefore demanded
one of *every* drop on their list:

| tile | said | required |
|---|---|---|
| Two Different GWD Weapons | 2 | all 4 |
| Two Different Doom Uniques | 2 | all 4 |
| Two Different Nightmare Uniques | 2 | all 10 |
| Three Different Common Raids Purples | 3 | all 5 |
| Three Different Mid-tier Raids Purples | 3 | all 7 |
| Three Different Raids Armour Pieces | 3 | all 9 |
| Onyx from 3 Different Sources | 3 | all 6 |

All seven now put their drops in one named group, which is what `per_set`
counts against. `Every DKs Unique` and `Every Zulrah Unique` have the same
shape and are **correct** — those really do want all of them.

**If you write a "two different X" tile, give its drops a group name.** The
pattern to copy is `Three Different GWD Armour Pieces`: ten drops, one group,
per_set 3.

## The five squares

| square | change |
|---|---|
| E7 One Teamcape from easies | drops added: Team cape zero / i / x |
| E6 Avernic Treads or Dom | drops added: Avernic treads, Dom |
| G5 Two Different GWD Weapons | Staff of the dead added, all five grouped, description updated |
| J2 3 CM or HMT Kits/Dusts | five drops: twisted ancestral colour kit, metamorphic dust, sanguine dust, sanguine ornament kit, holy ornament kit |
| G2 15M worth of Revenant emblems | now a `value` tile, target 15m, tiers in the description |

J2 has **five**, not three: the two dusts are CM/HMT-exclusive as well, and the
tile is named "Kits/**Dusts**". Uncapped, because it asks for three of them and
not three different ones.

G2's artefact values, from the wiki: emblem 500,000 exactly (Emblem Trader; GE
~498k), totem 1m, statuette 2m, medallion 4m, effigy 8m, relic 16m.

## Where an edit has to land

A square is a **snapshot**, not a link (0051), so a fix goes in three places —
all three were done here:

1. the square on the board (`admin_set_tile`);
2. the catalogue entry (`admin_save_library_tile`), or a re-deal brings the
   fault back — and pass `tags`, or saving **wipes** the `battleships v4` label;
3. the saved preset, re-saved afterwards, or loading it brings the fault back.

To call an admin RPC from the SQL editor, make the claims a real dependency so
they cannot be evaluated after the call:

```sql
with claims as (
  select set_config('request.jwt.claims',
           json_build_object('sub', (select id::text from profiles
                                      where is_admin order by id limit 1))::text,
           true) as c
)
select admin_set_tile(...) from claims;
```

## Still worth knowing

- `gh` and `python` are not on PATH here; use the browser for Actions and
  `node -e` for scripted edits.
- `web/src/lib/tileParser.js` shows as **binary** to git — a deliberate NUL byte
  used as a dedupe-key joiner, long predating this work. Do not "fix" it.
