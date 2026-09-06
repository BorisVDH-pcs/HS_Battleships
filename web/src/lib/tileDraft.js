// One tile, in the three shapes it has to travel in.
//
//   row     — what `admin_list_tiles` and `admin_list_library` return:
//             database columns, `required_evidence` / `early_complete` / `completion`.
//   draft   — what the form edits: every field always present, numbers as
//             strings, so a half-typed target is a valid draft rather than NaN.
//   payload — what `admin_set_tile` and `admin_save_library_tile` take: the
//             same object `parseTileLine` emits, so the builder and the paste
//             box hand the database identical work.
//
// The conversions live here rather than in the components because the picker,
// the square editor and the library editor all need them, and a second copy of
// "what does amount mean under the `value` rule" is exactly the kind of drift
// `claim_is_complete()` exists to prevent on the server side.

import { validateTileRow } from './tileParser.js';

export const RULES = [
  { value: 'points',
    label: 'Screenshots or points',
    hint: 'Finishes when the count — or, with priced drops, the points — reaches the target.' },
  { value: 'one_set',
    label: 'Any one full set',
    hint: 'Finishes as soon as one whole group has been handed in.' },
  { value: 'each_set',
    label: 'Something from every set',
    hint: 'Finishes when every group has the required number of different drops.' },
  { value: 'value',
    label: 'Total value in millions',
    hint: 'The team types what each drop was worth; finishes when the total reaches the target.' },
];

export const EMPTY_DRAFT = Object.freeze({
  name: '', icon: '', description: '',
  rule: 'points', amount: '1', perSet: '1', early: false,
  options: [], tags: '',
});

/**
 * A blank draft nobody else is holding.
 *
 * Spreading EMPTY_DRAFT copies its `options` *reference*, so two forms opened
 * from it would share one array. Nothing mutates that array today — every edit
 * builds a new one — but "today" is the whole guarantee, and it is one line to
 * not need it.
 */
export const newDraft = () => ({ ...EMPTY_DRAFT, options: [] });

/** A database row (board tile or library entry) as something the form can edit. */
export function draftFromRow(row) {
  if (!row) return { ...EMPTY_DRAFT };
  return {
    name: row.name ?? '',
    icon: row.icon ?? '',
    description: row.description ?? '',
    rule: row.completion ?? 'points',
    amount: String(row.required_evidence ?? 1),
    perSet: String(row.per_set ?? 1),
    early: Boolean(row.early_complete),
    options: (row.options ?? []).map((o) => ({
      label: o.label ?? '',
      points: String(o.points ?? 1),
      grp: o.grp ?? '',
    })),
    tags: (row.tags ?? []).join(', '),
  };
}

/**
 * The draft as the database wants it.
 *
 * Fields the rule does not use are dropped rather than sent as defaults: a
 * `one_set` tile has no target, and sending `amount: 1` would make the row read
 * as though it had one. `perSet` only survives `each_set` for the same reason.
 */
export function payloadFromDraft(draft, extra = {}) {
  const rule = draft.rule ?? 'points';
  const amount = Number(draft.amount);
  const perSet = Number(draft.perSet);
  const options = (draft.options ?? [])
    .map((o) => ({
      label: (o.label ?? '').trim(),
      points: rule === 'points' ? Number(o.points) : 1,
      ...((o.grp ?? '').trim() ? { grp: (o.grp ?? '').trim() } : {}),
    }))
    .filter((o) => o.label);

  return {
    name: (draft.name ?? '').trim(),
    icon: (draft.icon ?? '').trim(),
    ...(rule !== 'points' ? { rule } : {}),
    ...(rule === 'points' || rule === 'value'
      ? { amount: Number.isFinite(amount) ? amount : 1 }
      : {}),
    ...(rule === 'each_set' ? { perSet: Number.isFinite(perSet) ? perSet : 1 } : {}),
    ...(rule === 'points' && draft.early ? { early: true } : {}),
    ...(options.length ? { options } : {}),
    ...((draft.description ?? '').trim() ? { description: draft.description.trim() } : {}),
    ...extra,
  };
}

/** A library entry, ready to drop onto a square. */
export const payloadFromRow = (row, extra = {}) =>
  payloadFromDraft(draftFromRow(row), extra);

/**
 * What is wrong with this draft, if anything.
 *
 * Runs the payload through the same `validateTileRow` the paste box uses, and
 * adds the one rule the parser never has to state: a pasted line without a name
 * is an empty line and gets skipped, but a form can be submitted blank.
 */
export function validateDraft(draft, at = 'This tile') {
  const errors = [];
  if (!(draft.name ?? '').trim()) errors.push(`${at} needs a name.`);

  const payload = payloadFromDraft(draft);
  errors.push(...validateTileRow({ ...payload, rule: draft.rule ?? 'points' }, at));
  return errors;
}

/** One line saying how a tile is finished, for a list that has no room for more. */
export function ruleSummary(row) {
  const rule = row.completion ?? 'points';
  const options = row.options ?? [];

  if (rule === 'value') return `${row.required_evidence}m total`;
  if (rule === 'one_set') return 'any one full set';
  if (rule === 'each_set') {
    const per = row.per_set ?? 1;
    return per > 1 ? `${per} different from every set` : 'one from every set';
  }
  if (options.length > 0) return `${row.required_evidence} pts`;
  const count = row.required_evidence ?? 1;
  if (count > 1) return `${count} screenshot${count === 1 ? '' : 's'}${row.early_complete ? ', or fewer' : ''}`;
  return row.early_complete ? '1 screenshot, or fewer' : '1 screenshot';
}

/** The distinct group names on a tile, in the order its drops list them. */
export function groupsOf(row) {
  const groups = [];
  for (const option of row.options ?? []) {
    const name = option.grp || option.label;
    if (!groups.includes(name)) groups.push(name);
  }
  return groups;
}
