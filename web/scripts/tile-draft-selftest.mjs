// A tile goes out of the database as a row, into the form as a draft, and back
// as a payload — and the builder is the only way a board gets built, so a tile
// that changes shape on that trip changes on every edit anybody makes. This
// asserts the trip is lossless for every rule, and that `validateTileRow`
// agrees with the database about what is savable.
//
// (This used to start from lines of paste grammar. The paste box is gone and
// `parseTileText` with it; the row is the only shape a tile now arrives in.)

import assert from 'node:assert/strict';
import { validateTileRow } from '../src/lib/tileParser.js';
import {
  EMPTY_DRAFT, draftFromRow, payloadFromDraft, payloadFromRow,
  validateDraft, ruleSummary, groupsOf,
} from '../src/lib/tileDraft.js';

/** A tile as admin_list_tiles / admin_list_library return it. */
const asRow = (over) => ({
  name: 'A tile', icon: null, description: null,
  required_evidence: 1, completion: 'points', per_set: 1, options: [],
  ...over,
});

const drop = (label, points = 1, grp = null) => ({ label, points, grp });
const capped = (label, points, maxTimes) => ({ label, points, grp: null, max_times: maxTimes });

// ---- a row, edited and saved, is the same tile -------------------------------

const cases = [
  ['a plain tile', asRow({ name: 'Plain', icon: 'some_icon' })],
  ['a count of screenshots', asRow({ name: 'Five', required_evidence: 5 })],
  ['a priced tile', asRow({
    name: 'Priced', required_evidence: 6,
    options: [drop('Rare', 6), drop('Mid', 3), drop('Common', 2)],
  })],
  ['one full set', asRow({
    name: 'Armour', completion: 'one_set',
    options: [drop('Helm', 1, 'A'), drop('Body', 1, 'A'), drop('Helm', 1, 'B')],
  })],
  ['different drops from every set', asRow({
    name: 'Raids', completion: 'each_set', per_set: 2,
    options: [drop('D1', 1, 'R1'), drop('D2', 1, 'R1'),
              drop('D1', 1, 'R2'), drop('D2', 1, 'R2')],
  })],
  ['points from every set, repeats counting', asRow({
    name: 'GWD', completion: 'points_per_set', per_set: 2,
    options: [drop('Hilt', 1, 'Graardor'), drop('Tassets', 1, 'Graardor'),
              drop('Hilt', 1, 'Zilyana')],
  })],
  ['a priced tile whose drops cap their repeats', asRow({
    name: 'Challenge', required_evidence: 30,
    options: [capped('Cape', 2, 4), capped('Colosseum', 3, 3), drop('Awakened', 7)],
  })],
  ['a mix of capped and uncapped drops in one list', asRow({
    name: 'Mixed', required_evidence: 12,
    options: [capped('Once only', 7, 1), drop('As often as you like', 1)],
  })],
  // 2500 tenths of a million is the 250m the form types (lib/millions.js).
  ['a value target', asRow({ name: 'Coins', completion: 'value', required_evidence: 2500 })],
  ['prose', asRow({ name: 'Prose', required_evidence: 2, description: 'Only boss drops count' })],
];

for (const [what, row] of cases) {
  const once = payloadFromRow(row);
  // Round-tripped a second time through the row shape the first payload would
  // be stored as: a field that survives one trip but not two is still lost.
  const twice = payloadFromRow(asRow({
    ...row,
    required_evidence: once.amount ?? row.required_evidence,
    completion: once.rule ?? 'points',
    per_set: once.perSet ?? 1,
    // The payload names a cap `maxTimes` and the row names it `max_times`, the
    // same way `amount` and `required_evidence` are the same number under two
    // names. The database does this translation; here it has to be done by
    // hand, or the second trip would "lose" a field that never travelled.
    options: (once.options ?? []).map(({ maxTimes, ...option }) => ({
      ...option,
      ...(maxTimes === undefined ? {} : { max_times: maxTimes }),
    })),
  }));

  assert.deepEqual(twice, once, `round trip differs for ${what}`);
  assert.deepEqual(validateDraft(draftFromRow(row), 'A1'), [],
    `round trip should stay valid for ${what}`);
}

// ---- the form can produce what the paste box rejects, and is told so --------

{
  // A set rule with no drops: the one the database also refuses, so the form
  // must never let it be submitted.
  const errors = validateDraft({ ...EMPTY_DRAFT, name: 'Sets', rule: 'one_set' }, 'A1');
  assert.deepEqual(errors, ['A1 uses a set rule but lists no drops.']);
}

{
  const errors = validateDraft({
    ...EMPTY_DRAFT, name: 'Value', rule: 'value', amount: '250',
    options: [{ label: 'A drop', points: '1', grp: '' }],
  }, 'B2');
  assert.deepEqual(errors, ['B2 is value-based and cannot also list drops.']);
}

{
  // A form can be submitted blank, and `validateTileRow` has nothing to say
  // about a missing name — so `validateDraft` is the only thing standing
  // between an empty form and a tile called "Tile".
  assert.deepEqual(validateDraft({ ...EMPTY_DRAFT }, 'C3'), ['C3 needs a name.']);
  assert.deepEqual(validateTileRow({ name: '', rule: 'points', amount: 1 }, 'C3'), []);
}

{
  // points_per_set needs its drops like the other grouped rules, and unlike
  // each_set it accepts a group too small to yield that many DIFFERENT ones.
  assert.deepEqual(
    validateDraft({ ...EMPTY_DRAFT, name: 'Sets', rule: 'points_per_set' }, 'E5'),
    ['E5 uses a set rule but lists no drops.']
  );
  assert.deepEqual(
    validateDraft({
      ...EMPTY_DRAFT, name: 'Solo boss', rule: 'points_per_set', perSet: '2',
      options: [{ label: 'Only drop', points: '1', grp: 'Boss' }],
    }, 'F6'),
    []
  );
}

{
  // A cleared target must not quietly become 1. The database would clamp it to
  // 1 and save a tile that finishes on one screenshot, which is not what an
  // empty box means — so it has to fail validation and hold the save button
  // instead. It still leaves as a number, never NaN.
  const draft = { ...EMPTY_DRAFT, name: 'Typing', amount: '' };
  assert.equal(Number.isFinite(payloadFromDraft(draft).amount), true);
  assert.deepEqual(validateDraft(draft, 'D4'), ['D4 asks for evidence outside 1–30.']);
}

// ---- fields a rule does not use are dropped, not defaulted ------------------

{
  const payload = payloadFromDraft({
    ...EMPTY_DRAFT, name: 'Sets', rule: 'one_set', amount: '7', perSet: '3',
    options: [{ label: 'Helm', points: '1', grp: 'A' }],
  });
  assert.equal('amount' in payload, false, 'a set tile has no target');
  assert.equal('perSet' in payload, false, 'one_set does not use perSet');
}

{
  const payload = payloadFromDraft({
    ...EMPTY_DRAFT, name: 'GWD', rule: 'points_per_set', amount: '7', perSet: '2',
    options: [{ label: 'Hilt', points: '3', grp: 'Graardor' }],
  });
  assert.equal('amount' in payload, false, 'a per-set tile has no whole-tile target');
  assert.equal(payload.perSet, 2);
  // Its prices are read by claim_is_complete, unlike every other set rule's.
  assert.equal(payload.options[0].points, 3);
}

{
  // A blank cap box means uncapped, and must leave as an absent field rather
  // than a 0 or a NaN: the column is nullable precisely so that "no limit" and
  // "a limit of something" are different answers, and every drop saved before
  // the column existed gives the blank one.
  const payload = payloadFromDraft({
    ...EMPTY_DRAFT, name: 'Mixed', amount: '12',
    options: [
      { label: 'Once', points: '7', grp: '', maxTimes: '1' },
      { label: 'Freely', points: '1', grp: '', maxTimes: '' },
    ],
  });
  assert.equal(payload.options[0].maxTimes, 1);
  assert.equal('maxTimes' in payload.options[1], false, 'a blank cap is no cap');
}

{
  // A set rule drops the cap with the price, for the same reason: a repeat is
  // already worth nothing there, so a stored cap would be a number nothing
  // reads and a reader would rightly assume it meant something.
  const payload = payloadFromDraft({
    ...EMPTY_DRAFT, name: 'Sets', rule: 'one_set',
    options: [{ label: 'Helm', points: '3', grp: 'A', maxTimes: '2' }],
  });
  assert.equal('maxTimes' in payload.options[0], false);
  assert.equal(payload.options[0].points, 1);
}

{
  // The unfinishable shape, refused through the form as well as the parser.
  const errors = validateDraft({
    ...EMPTY_DRAFT, name: 'Capped', amount: '30',
    options: [
      { label: 'Cheap', points: '2', grp: '', maxTimes: '4' },
      { label: 'Dear', points: '7', grp: '', maxTimes: '1' },
    ],
  }, 'G7');
  assert.deepEqual(errors, ['G7 caps every drop, which tops out at 15 of the 30 points it asks for.']);
}

// ---- what the picker prints -------------------------------------------------

assert.equal(ruleSummary({ completion: 'value', required_evidence: 2500 }), '250m total');
assert.equal(ruleSummary({ completion: 'value', required_evidence: 5 }), '0.5m total');

// The form says millions, the payload says tenths, and a decimal comma
// survives the trip — the whole reason the unit changed.
{
  const draft = { ...EMPTY_DRAFT, name: 'Artefacts', rule: 'value', amount: '0,5' };
  assert.equal(payloadFromDraft(draft).amount, 5);
  assert.equal(draftFromRow(asRow({
    name: 'Artefacts', completion: 'value', required_evidence: 150,
  })).amount, '15');
}
assert.equal(ruleSummary({ completion: 'one_set', options: [] }), 'any one full set');
assert.equal(ruleSummary({ completion: 'each_set', per_set: 2 }), '2 different from every set');
assert.equal(ruleSummary({ completion: 'each_set', per_set: 1 }), 'one from every set');
assert.equal(ruleSummary({ completion: 'points_per_set', per_set: 2 }), '2 from every set');
assert.equal(ruleSummary({ completion: 'points_per_set', per_set: 1 }), 'one from every set');
assert.equal(
  ruleSummary({ completion: 'points', required_evidence: 6, options: [{ label: 'A', points: 6 }] }),
  '6 pts'
);
assert.equal(ruleSummary({ completion: 'points', required_evidence: 1, options: [] }), '1 screenshot');
assert.equal(
  ruleSummary({ completion: 'points', required_evidence: 19, options: [] }),
  '19 screenshots'
);

assert.deepEqual(
  groupsOf({ options: [
    { grp: 'A', label: 'Helm' }, { grp: 'A', label: 'Body' },
    { grp: 'B', label: 'Helm' }, { label: 'Instant win' },
  ] }),
  ['A', 'B', 'Instant win']
);

console.log('Tile draft and catalogue round-trip self-test passed.');
