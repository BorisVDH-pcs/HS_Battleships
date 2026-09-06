// The builder writes tiles through the same validation the paste box does, and
// the whole point of `validateTileRow` living in tileParser.js is that the two
// cannot drift. That is only true if something checks it, so this asserts the
// round trip: a line of paste grammar, parsed, is the same payload the form
// produces from the row that line would create.

import assert from 'node:assert/strict';
import { parseTileText, validateTileRow } from '../src/lib/tileParser.js';
import {
  EMPTY_DRAFT, draftFromRow, payloadFromDraft, payloadFromRow,
  validateDraft, ruleSummary, groupsOf,
} from '../src/lib/tileDraft.js';

/** The database row a pasted line becomes, as admin_list_tiles would return it. */
function asRow(payload) {
  return {
    name: payload.name,
    icon: payload.icon || null,
    description: payload.description ?? null,
    required_evidence: payload.amount ?? 1,
    early_complete: Boolean(payload.early),
    completion: payload.rule ?? 'points',
    per_set: payload.perSet ?? 1,
    options: (payload.options ?? []).map((o) => ({
      label: o.label, points: o.points, grp: o.grp ?? null,
    })),
  };
}

// ---- paste grammar in, identical payload out --------------------------------

const cases = [
  'A plain tile | some_icon',
  'Five drops | some_icon | 5',
  'A shorter route | some_icon | 19+',
  'Priced drops | some_icon | 6 > Rare:6, Mid:3, Common:2',
  'One full set | armour | set > A/Helm, A/Body, B/Helm, B/Body',
  'From every raid | raids | each 2 > R1/D1, R1/D2, R2/D1, R2/D2',
  'A value target | coins | 250m',
  'With prose | some_icon | 2 :: Only boss drops count',
];

/**
 * The payload as the database will read it.
 *
 * The two producers disagree about one harmless thing: the parser omits
 * `amount` when a line carries no amount field, the form always states it. Both
 * land on `required_evidence = 1`, because that is the column default and
 * `admin_set_tile` coalesces to it either way — so the comparison is made on
 * what gets stored rather than on which keys were spelled out.
 */
const stored = (payload) => ({
  amount: 1, early: false, rule: 'points', perSet: 1,
  icon: '', description: '', options: [],
  ...payload,
});

for (const line of cases) {
  const { rows, errors } = parseTileText(line, 10);
  assert.deepEqual(errors, [], `${line} should parse cleanly`);

  const { row: _r, col: _c, ...pasted } = rows[0];
  const rebuilt = payloadFromRow(asRow(pasted));

  assert.deepEqual(stored(rebuilt), stored(pasted), `round trip differs for: ${line}`);
  assert.deepEqual(validateDraft(draftFromRow(asRow(pasted)), 'A1'), [],
    `round trip should stay valid for: ${line}`);
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
  // A blank name is an empty line to the parser and simply skipped; a form can
  // be submitted blank, so validateDraft has to catch it where the parser does not.
  assert.deepEqual(validateDraft({ ...EMPTY_DRAFT }, 'C3'), ['C3 needs a name.']);
  assert.deepEqual(validateTileRow({ name: '', rule: 'points', amount: 1 }, 'C3'), []);
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
    ...EMPTY_DRAFT, name: 'Early', rule: 'value', amount: '250', early: true,
  });
  assert.equal('early' in payload, false, 'early survives only the points rule');
}

// ---- what the picker prints -------------------------------------------------

assert.equal(ruleSummary({ completion: 'value', required_evidence: 250 }), '250m total');
assert.equal(ruleSummary({ completion: 'one_set', options: [] }), 'any one full set');
assert.equal(ruleSummary({ completion: 'each_set', per_set: 2 }), '2 different from every set');
assert.equal(ruleSummary({ completion: 'each_set', per_set: 1 }), 'one from every set');
assert.equal(
  ruleSummary({ completion: 'points', required_evidence: 6, options: [{ label: 'A', points: 6 }] }),
  '6 pts'
);
assert.equal(ruleSummary({ completion: 'points', required_evidence: 1, options: [] }), '1 screenshot');
assert.equal(
  ruleSummary({ completion: 'points', required_evidence: 19, early_complete: true, options: [] }),
  '19 screenshots, or fewer'
);

assert.deepEqual(
  groupsOf({ options: [
    { grp: 'A', label: 'Helm' }, { grp: 'A', label: 'Body' },
    { grp: 'B', label: 'Helm' }, { label: 'Instant win' },
  ] }),
  ['A', 'B', 'Instant win']
);

console.log('Tile draft and catalogue round-trip self-test passed.');
