import assert from 'node:assert/strict';
import { parseTileText } from '../src/lib/tileParser.js';
import {
  completedEachSetGroupNames,
  tileProgress,
  tileProgressText,
  unavailableSetOptionIds,
} from '../src/lib/tileProgress.js';
import { evidenceEventText } from '../src/lib/eventText.js';

const parse = (line) => parseTileText(line, 10);

{
  const { rows, errors } = parse('Kill > 50 creatures | icon | 2 :: URL: https://example.test/a|b');
  assert.deepEqual(errors, []);
  assert.deepEqual(rows[0], {
    row: 1, col: 1, name: 'Kill > 50 creatures', icon: 'icon', amount: 2,
    description: 'URL: https://example.test/a|b',
  });
}

{
  const { rows, errors } = parse('Weighted | icon | 6 > Rare:6, Common:2');
  assert.deepEqual(errors, []);
  assert.equal(rows[0].amount, 6);
  assert.deepEqual(rows[0].options, [
    { label: 'Rare', points: 6 },
    { label: 'Common', points: 2 },
  ]);
}

{
  const { rows, errors } = parse(
    'Armour | icon | set > A/Helm, A/Body, B/Helm, B/Body, Instant win'
  );
  assert.deepEqual(errors, []);
  assert.equal(rows[0].rule, 'one_set');
  assert.deepEqual(rows[0].options[0], { grp: 'A', label: 'Helm', points: 1 });
  assert.deepEqual(rows[0].options[4], { label: 'Instant win', points: 1 });
}

{
  const { rows, errors } = parse(
    'Raids | icon | each 2 > CoX/One, CoX/Two, ToB/One, ToB/Two'
  );
  assert.deepEqual(errors, []);
  assert.equal(rows[0].rule, 'each_set');
  assert.equal(rows[0].perSet, 2);
}

{
  const { rows, errors } = parse('Value | coins | 250m');
  assert.deepEqual(errors, []);
  assert.deepEqual(rows[0], {
    row: 1, col: 1, name: 'Value', icon: 'coins', amount: 250, rule: 'value',
  });
}

for (const [line, part] of [
  ['Bad | icon | surprise', 'unknown completion rule'],
  ['Bad | icon | set', 'lists no drops'],
  ['Bad | icon | each 2 > A/Only, B/One, B/Two', 'fewer than 2'],
  ['Bad | icon | 250m > Drop:2', 'cannot also list drops'],
  ['Bad | icon | 6 > Drop', 'without a name or points'],
]) {
  const { errors } = parse(line);
  assert.ok(errors.some((error) => error.includes(part)), `${line}: ${errors.join(' ')}`);
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
