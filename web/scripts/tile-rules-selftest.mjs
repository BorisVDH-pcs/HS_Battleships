import assert from 'node:assert/strict';
import { validateTileRow } from '../src/lib/tileParser.js';
import {
  completedEachSetGroupNames,
  tileProgress,
  tileProgressText,
  unavailableSetOptionIds,
} from '../src/lib/tileProgress.js';
import { evidenceEventText } from '../src/lib/eventText.js';

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
    { rule: 'value', amount: 250, options: [{ label: 'Drop', points: 2 }] },
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
  const tile = { completion: 'value', required_evidence: 250, evidence_points: 190 };
  assert.equal(tileProgress(tile, { points: 59 }).done, false);
  assert.equal(tileProgress(tile, { points: 60 }).done, true);
  assert.equal(tileProgressText(tile), '190/250m');
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
    required_evidence: 250, points_awarded: 60, points_total: 190,
  }),
  'Boris submitted a drop worth 60m for Boss uniques (190/250m).'
);

console.log('Tile parser and completion-rule self-test passed.');
