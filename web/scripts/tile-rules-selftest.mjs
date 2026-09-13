import assert from 'node:assert/strict';
import { validateTileRow } from '../src/lib/tileParser.js';
import {
  completedEachSetGroupNames,
  tileProgress,
  pointsLabel,
  replayTile,
  tileShowsPrices,
  tileProgressText,
  unavailableSetOptionIds,
} from '../src/lib/tileProgress.js';
import { evidenceEventText } from '../src/lib/eventText.js';
import { millionsLabel, millionsToTenths } from '../src/lib/millions.js';

// ---- the tiles a rule refuses to describe -----------------------------------
// Each of these is also refused by the database, in assert_tile_rule_ok() or
// claim_is_complete()'s own guards. The form asks first so the answer does not
// arrive as a Postgres exception halfway through building a board.

for (const [what, row, part] of [
  ['a set rule with no drops',
    { rule: 'one_set', options: [] }, 'lists no drops'],
  ['each_set with a group too small to ever fill',
    { rule: 'each_set', perSet: 2,
      options: [{ grp: 'A', label: 'Only', points: 1 },
                { grp: 'B', label: 'One', points: 1 },
                { grp: 'B', label: 'Two', points: 1 }] }, 'fewer than 2'],
  ['a value tile that also lists drops',
    { rule: 'value', amount: 2500, options: [{ label: 'Drop', points: 2 }] },
    'cannot also list drops'],
  ['a priced drop with no price',
    { rule: 'points', amount: 6, options: [{ label: 'Drop' }] },
    'without a name or points'],
  ['a per-set quota out of range',
    { rule: 'points_per_set', perSet: 99,
      options: [{ grp: 'A', label: 'Drop', points: 1 }] }, 'outside 1–30'],
]) {
  const errors = validateTileRow(row);
  assert.ok(errors.some((error) => error.includes(part)),
    `${what}: ${errors.join(' ') || 'no errors at all'}`);
}

{
  const options = [
    { id: 'a1', grp: 'A', label: 'Helm', taken: true },
    { id: 'a2', grp: 'A', label: 'Body', taken: false },
    { id: 'b1', grp: 'B', label: 'Helm', taken: false },
    { id: 'b2', grp: 'B', label: 'Body', taken: false },
  ];
  const tile = { completion: 'one_set', options };
  assert.equal(tileProgress(tile).done, false);
  assert.equal(tileProgress(tile, { optionIds: ['a2'] }).done, true);
  assert.equal(tileProgress(tile, { optionIds: ['b1'] }).done, false);
  assert.equal(tileProgressText(tile), 'Best set (A) 1/2');
}

{
  const options = [
    { id: 'c1', grp: 'CoX', label: 'One', taken: true },
    { id: 'c2', grp: 'CoX', label: 'Two', taken: false },
    { id: 't1', grp: 'ToB', label: 'One', taken: true },
    { id: 't2', grp: 'ToB', label: 'Two', taken: false },
  ];
  const tile = { completion: 'each_set', per_set: 2, options };
  assert.equal(tileProgress(tile, { optionIds: ['c2', 't2'] }).done, true);
  assert.equal(tileProgress(tile, { optionIds: ['c2', 'c2', 't2'] }).done, true);
  assert.equal(tileProgress(tile, { optionIds: ['c2'] }).done, false);
  assert.equal(tileProgressText(tile), '0/2 sets complete');
  assert.deepEqual(
    [...unavailableSetOptionIds(tile, { optionIds: ['c2'] })].sort(),
    ['c1', 'c2', 't1'].sort(),
  );
  assert.deepEqual(
    [...unavailableSetOptionIds(tile, { optionIds: ['c2', 't2'] })].sort(),
    ['c1', 'c2', 't1', 't2'].sort(),
  );
  assert.deepEqual([...completedEachSetGroupNames(tile)], []);

  const coxComplete = {
    ...tile,
    options: options.map((option) => ({
      ...option,
      taken: option.grp === 'CoX' || option.id === 't1',
    })),
  };
  assert.deepEqual([...completedEachSetGroupNames(coxComplete)], ['CoX']);
}

{
  const options = [
    { id: 'part-a', grp: 'Components', label: 'Part A', taken: false },
    { id: 'part-b', grp: 'Components', label: 'Part B', taken: false },
    { id: 'part-c', grp: 'Components', label: 'Part C', taken: false },
    { id: 'part-d', grp: 'Components', label: 'Part D', taken: false },
  ];
  const tile = { completion: 'each_set', per_set: 2, options };
  assert.equal(tileProgressText(tile), '0/2 items collected');
  assert.equal(tileProgress(tile, { optionIds: ['part-a'] }).done, false);
  assert.equal(tileProgress(tile, { optionIds: ['part-a', 'part-a'] }).done, false);
  assert.equal(tileProgress(tile, { optionIds: ['part-a', 'part-d'] }).done, true);
}

// points_per_set: grouped like each_set, but a repeat counts. Two of the same
// Bandos piece finishes Graardor, which is the entire reason the rule exists.
{
  const options = [
    { id: 'g1', grp: 'Graardor', label: 'Chestplate', points: 1, got: 2 },
    { id: 'g2', grp: 'Graardor', label: 'Tassets', points: 1, got: 0 },
    { id: 'z1', grp: 'Zilyana', label: 'Hilt', points: 1, got: 0 },
    { id: 'z2', grp: 'Zilyana', label: 'Crossbow', points: 1, got: 0 },
  ];
  const tile = { completion: 'points_per_set', per_set: 2, options };

  const now = tileProgress(tile);
  assert.equal(now.done, false);
  assert.equal(now.groups.find((g) => g.name === 'Graardor').taken, 2);
  assert.equal(tileProgressText(tile), '1/2 sets complete');

  // Graardor is full, so its drops close; Zilyana's stay pickable, repeats
  // included — `z1` twice is a legitimate way to finish it.
  assert.deepEqual([...completedEachSetGroupNames(tile)], ['Graardor']);
  assert.deepEqual([...unavailableSetOptionIds(tile)].sort(), ['g1', 'g2']);
  assert.equal(tileProgress(tile, { optionIds: ['z1'] }).done, false);
  assert.equal(tileProgress(tile, { optionIds: ['z1', 'z1'] }).done, true);
  assert.equal(tileProgress(tile, { optionIds: ['z1', 'z2'] }).done, true);

  // The same shape under each_set: a repeat is worth nothing there.
  const strict = { ...tile, completion: 'each_set' };
  assert.equal(tileProgress(strict, { optionIds: ['z1', 'z1'] }).done, false);
}

// A lone group is "this many points from this list", not "0/1 sets".
{
  const tile = {
    completion: 'points_per_set', per_set: 3,
    options: [
      { id: 'r1', grp: 'Rings', label: 'Berserker', points: 1, got: 1 },
      { id: 'r2', grp: 'Rings', label: 'Warrior', points: 2, got: 0 },
    ],
  };
  assert.equal(tileProgressText(tile), '1/3 pts');
  assert.equal(tileProgress(tile, { optionIds: ['r2'] }).done, true);
  assert.equal(tileProgress(tile, { optionIds: ['r1'] }).done, false);
  assert.equal(tileProgress(tile, { optionIds: ['r1', 'r1'] }).done, true);
}

// A group of one can be finished under points_per_set and must not be
// rejected by the validator the way each_set rightly rejects it.
{
  const row = {
    rule: 'points_per_set', perSet: 2,
    options: [{ grp: 'Solo', label: 'Only drop', points: 1 }],
  };
  assert.deepEqual(validateTileRow(row), []);
  assert.ok(
    validateTileRow({ ...row, rule: 'each_set' })
      .some((error) => error.includes('fewer than 2'))
  );
  assert.ok(
    validateTileRow({ rule: 'points_per_set', perSet: 2, options: [] })
      .some((error) => error.includes('lists no drops'))
  );
}

assert.equal(
  evidenceEventText({
    completion: 'points_per_set', uploaded_by_name: 'Boris', tile_name: 'GWD',
    option_label: 'Bandos chestplate', required_evidence: 2,
    points_awarded: 1, points_total: 3,
  }),
  'Boris submitted Bandos chestplate for GWD.'
);

{
  // Value tiles count in TENTHS of a million (lib/millions.js): 2500 is the
  // 250m target, 1900 is 190m banked. The counter divides it back, and a
  // whole number of millions must not sprout a ".0".
  const tile = { completion: 'value', required_evidence: 2500, evidence_points: 1900 };
  assert.equal(tileProgress(tile, { points: 599 }).done, false);
  assert.equal(tileProgress(tile, { points: 600 }).done, true);
  assert.equal(tileProgressText(tile), '190/250m');
  // The half million this unit exists for.
  assert.equal(
    tileProgressText({ completion: 'value', required_evidence: 150, evidence_points: 5 }),
    '0.5/15m'
  );
  assert.equal(millionsToTenths('0,5'), 5);
  assert.equal(millionsToTenths('0.5'), 5);
  assert.equal(millionsToTenths('15'), 150);
  assert.equal(millionsToTenths('0.55'), null);
  assert.equal(millionsToTenths(''), null);
  assert.equal(millionsLabel(5), '0.5');
  assert.equal(millionsLabel(2500), '250');
}

assert.equal(
  evidenceEventText({
    completion: 'one_set', uploaded_by_name: 'Boris', tile_name: 'Barrows',
    option_label: "Dharok's helm", required_evidence: 1, points_awarded: 1, points_total: 3,
  }),
  "Boris submitted Dharok's helm for Barrows."
);
assert.equal(
  evidenceEventText({
    completion: 'value', uploaded_by_name: 'Boris', tile_name: 'Boss uniques',
    required_evidence: 2500, points_awarded: 600, points_total: 1900,
  }),
  'Boris submitted a drop worth 60m for Boss uniques (190/250m).'
);

// ---- a drop that may only count so many times -------------------------------
// The challenge tile: a price list with a target, where every entry also says
// how often it is allowed to count. Without the cap the cheapest drop on the
// list is a route to the whole target on its own, which is what it forbids.

{
  const options = [
    { id: 'cape',     label: 'Fire cape',  points: 2, max_times: 4, got: 4 },
    { id: 'col',      label: 'Colosseum',  points: 3, max_times: 3, got: 1 },
    { id: 'inferno',  label: 'Inferno',    points: 4, max_times: 2, got: 0 },
    { id: 'delve',    label: 'Deep delve', points: 7, max_times: 1, got: 0 },
  ];
  const tile = { completion: 'points', required_evidence: 30, options, evidence_points: 11 };

  // Spent on its own count, with nothing grouped and no repeat rule in sight —
  // which is the case this function had nothing to say about before.
  assert.deepEqual([...unavailableSetOptionIds(tile)], ['cape']);

  // Staging spends it too, so the picker closes the last one as it is assigned
  // rather than after the round trip that would have been refused.
  assert.deepEqual(
    [...unavailableSetOptionIds(tile, { optionIds: ['inferno', 'inferno'] })].sort(),
    ['cape', 'inferno'],
  );
  assert.deepEqual(
    [...unavailableSetOptionIds(tile, { optionIds: ['col', 'col'] })].sort(),
    ['cape', 'col'],
  );

  // The counter is still the frozen server total; a cap changes which drops
  // can be picked, never what an accepted screenshot was worth.
  assert.equal(tileProgressText(tile), '11/30 pts');
  assert.equal(tileProgress(tile, { points: 18 }).done, false);
  assert.equal(tileProgress(tile, { points: 19 }).done, true);
}

{
  // An uncapped drop beside capped ones is untouched by any of it.
  const tile = {
    completion: 'points', required_evidence: 10,
    options: [
      { id: 'capped',   label: 'Capped',   points: 2, max_times: 1, got: 1 },
      { id: 'uncapped', label: 'Uncapped', points: 1, got: 9 },
    ],
  };
  assert.deepEqual([...unavailableSetOptionIds(tile)], ['capped']);
}

{
  // A cap under points_per_set clamps what a group has banked, exactly as
  // claim_is_complete() clamps it — otherwise the card draws a group as full
  // that the server will refuse to treat as full.
  const tile = {
    completion: 'points_per_set', per_set: 3,
    options: [
      { id: 'a1', grp: 'A', label: 'Cheap', points: 1, max_times: 2, got: 5 },
      { id: 'a2', grp: 'A', label: 'Dear',  points: 1, got: 0 },
    ],
  };
  assert.equal(tileProgress(tile).groups[0].taken, 2, 'five submissions, capped at two');
  assert.equal(tileProgress(tile).done, false);
  assert.equal(tileProgress(tile, { optionIds: ['a1'] }).done, false, 'still capped');
  assert.equal(tileProgress(tile, { optionIds: ['a2'] }).done, true);
}

{
  // What the validator refuses. A cap out of the column's range, and the one
  // shape that leaves a tile nobody can finish: every drop capped, and the
  // caps between them worth less than the target.
  assert.ok(
    validateTileRow({ rule: 'points', amount: 6, options: [
      { label: 'Drop', points: 1, maxTimes: 99 },
    ] }).some((error) => error.includes('other than 1–30 times')),
  );
  assert.ok(
    validateTileRow({ rule: 'points', amount: 30, options: [
      { label: 'Cheap', points: 2, maxTimes: 4 },
      { label: 'Dear',  points: 7, maxTimes: 1 },
    ] }).some((error) => error.includes('tops out at 15 of the 30')),
  );
  // One uncapped drop makes any target reachable, so nothing is refused.
  assert.deepEqual(
    validateTileRow({ rule: 'points', amount: 30, options: [
      { label: 'Cheap', points: 2, maxTimes: 4 },
      { label: 'Dear',  points: 7 },
    ] }),
    [],
  );
  // And the real thing validates.
  assert.deepEqual(
    validateTileRow({ rule: 'points', amount: 30, options: [
      { label: 'Fire cape',  points: 2, maxTimes: 4 },
      { label: 'TOA',        points: 3, maxTimes: 3 },
      { label: 'Colosseum',  points: 3, maxTimes: 3 },
      { label: 'Inferno',    points: 4, maxTimes: 2 },
      { label: 'Deep delve', points: 7, maxTimes: 1 },
    ] }),
    [],
  );
}

// ---- when a price is worth printing -----------------------------------------
// Asked of the TILE, never of the one option: on a mixed list "1 pt" says this
// drop is the cheap one, and hiding it there would leave a price to be inferred
// from the absence of a price.

{
  // H1 and G3's shape: pick any one of these, nothing is worth more than
  // anything else. The counter already reads 0/1; a column of "1 pt" repeats it.
  assert.equal(tileShowsPrices({ options: [
    { id: 'a', label: 'Sraracha', points: 1 },
    { id: 'b', label: 'Jar of eyes', points: 1 },
  ] }), false);

  // Still nothing to tell apart when several are needed.
  assert.equal(tileShowsPrices({ options: [
    { id: 'a', points: 1 }, { id: 'b', points: 1 }, { id: 'c', points: 1 },
  ] }), false);

  // I9's shape: the prices are the whole point of the list.
  assert.equal(tileShowsPrices({ options: [
    { id: 'cape', points: 2 }, { id: 'vard', points: 7 },
  ] }), true);

  // A single 1 among larger prices keeps every price, itself included.
  assert.equal(tileShowsPrices({ options: [
    { id: 'cheap', points: 1 }, { id: 'dear', points: 6 },
  ] }), true);

  // A tile with no drops at all prices nothing.
  assert.equal(tileShowsPrices({ options: [] }), false);
  assert.equal(tileShowsPrices({}), false);

  // An option with no price stated is worth 1, the same as the column default.
  assert.equal(tileShowsPrices({ options: [{ id: 'a' }, { id: 'b' }] }), false);

  assert.equal(pointsLabel(1), '1 pt');
  assert.equal(pointsLabel(2), '2 pts');
  assert.equal(pointsLabel(30), '30 pts');
}

// ---- the browser's half of the builder's tile tester -------------------------
// replayTile() plays picks into a fresh claim the way admin_test_tile() does
// server-side. The builder shows both answers and shouts when they differ, so
// these assertions are this side's contribution to that comparison.

{
  const tile = {
    completion: 'points', required_evidence: 30,
    options: [
      { id: 'cape', label: 'Fire cape', points: 2, max_times: 4 },
      { id: 'col',  label: 'Colosseum', points: 3, max_times: 3 },
      { id: 'inf',  label: 'Inferno',   points: 4, max_times: 2 },
      { id: 'vard', label: 'Vard',      points: 7, max_times: 1 },
    ],
  };

  // Fifteen fire capes: four count, eleven are skipped, and 8 is not 30 —
  // the same answer the database gave for the same list.
  const capes = replayTile(tile, Array.from({ length: 15 }, () => ({ optionId: 'cape' })));
  assert.equal(capes.complete, false);
  assert.equal(capes.points, 8);
  assert.equal(capes.accepted, 4);
  assert.equal(capes.skipped, 11);

  // 4 capes (8) + 3 colosseum (9) + 2 inferno (8) + 1 vard (7) = 32, over the
  // line on the tenth submission.
  const mixed = [
    ...Array.from({ length: 4 }, () => ({ optionId: 'cape' })),
    ...Array.from({ length: 3 }, () => ({ optionId: 'col' })),
    ...Array.from({ length: 2 }, () => ({ optionId: 'inf' })),
    { optionId: 'vard' },
  ];
  const run = replayTile(tile, mixed);
  assert.equal(run.complete, true);
  assert.equal(run.completedAtStep, 10);
  assert.equal(run.points, 32);
  assert.equal(run.accepted, 10);
}

{
  // A set tile: a repeat is skipped, and the tile closes on the last DIFFERENT
  // piece rather than on the fourth submission.
  const tile = {
    completion: 'one_set',
    options: [
      { id: 'h', grp: 'A', label: 'Helm' },
      { id: 'b', grp: 'A', label: 'Body' },
      { id: 'x', grp: 'B', label: 'Other' },
    ],
  };
  const run = replayTile(tile, [
    { optionId: 'h' }, { optionId: 'h' }, { optionId: 'b' },
  ]);
  assert.equal(run.complete, true);
  assert.equal(run.completedAtStep, 3);
  assert.equal(run.skipped, 1, 'the repeat could not have been submitted');
}

{
  // H2's shape: two uniques from each boss, repeats counting. A THIRD drop
  // into a boss that already has its two is worth nothing and cannot be
  // submitted — the picker closes the whole group, and since 20260912235000
  // `evidence_refusal()` turns it away server-side as well. This was found by
  // playing the tile in the builder, where the preview had been offering it.
  const tile = {
    completion: 'points_per_set', per_set: 2,
    options: [
      { id: 'hilt', grp: 'General Graardor', label: 'Bandos hilt', points: 1 },
      { id: 'tass', grp: 'General Graardor', label: 'Bandos tassets', points: 1 },
      { id: 'acp',  grp: "Kree'arra", label: 'Armadyl chestplate', points: 1 },
      { id: 'ahilt', grp: "Kree'arra", label: 'Armadyl hilt', points: 1 },
    ],
  };

  const thrice = replayTile(tile, [
    { optionId: 'hilt' }, { optionId: 'hilt' }, { optionId: 'hilt' },
  ]);
  assert.equal(thrice.accepted, 2, 'the third hilt cannot be submitted');
  assert.equal(thrice.skipped, 1);
  assert.equal(thrice.complete, false, "Kree'arra is still empty");

  // Nor can a DIFFERENT drop from the same finished boss.
  const sibling = replayTile(tile, [
    { optionId: 'hilt' }, { optionId: 'hilt' }, { optionId: 'tass' },
  ]);
  assert.equal(sibling.accepted, 2);
  assert.deepEqual(
    [...unavailableSetOptionIds(sibling.state)].sort(), ['hilt', 'tass'],
    'the whole group closes, not just the drop that filled it',
  );

  // And the tile finishes when the second boss is served, repeats included.
  const both = replayTile(tile, [
    { optionId: 'hilt' }, { optionId: 'hilt' },
    { optionId: 'acp' }, { optionId: 'acp' },
  ]);
  assert.equal(both.complete, true);
  assert.equal(both.completedAtStep, 4);
}

{
  // A plain screenshot tile: no drops to pick, so every entry is worth one.
  const tile = { completion: 'points', required_evidence: 3, options: [] };
  assert.equal(replayTile(tile, [{}, {}]).complete, false);
  assert.equal(replayTile(tile, [{}, {}, {}]).completedAtStep, 3);

  // A value tile sums what was typed, and refuses what is out of range.
  // Picks are in stored tenths, the shape admin_test_tile() takes.
  const value = { completion: 'value', required_evidence: 2500, options: [] };
  assert.equal(replayTile(value, [{ amount: 1000 }, { amount: 1500 }]).complete, true);
  assert.equal(replayTile(value, [{ amount: 0 }, { amount: 2500 }]).skipped, 1);
}

console.log('Tile parser and completion-rule self-test passed.');
