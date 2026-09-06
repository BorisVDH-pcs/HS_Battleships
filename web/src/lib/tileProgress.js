// How far along a claimed tile is, under whichever rule it uses (0049).
//
// One module because three places need the same answer and must not disagree:
// the card's counter, the picker that decides when Submit becomes "Submit &
// fire", and the "?" panel that shows the sets filling up. The database is
// still the authority — claim_is_complete() decides whether a shot actually
// goes off — but the interface has to predict it correctly or the button lies.
//
// The rules, mirroring the migration:
//   points   sum the points of what was submitted; repeats count.
//   value    same sum, except the numbers were typed by the submitter.
//   one_set  finished when any ONE group is complete.
//   each_set finished when EVERY group has `per_set` distinct options.
//
// An option with no `grp` is its own group, which is what makes "one from each
// of five bosses" and "two different pieces of one set" the same mechanism.

/** Options bucketed into their sets, with how many of each are in already. */
export function tileGroups(options = []) {
  const byName = new Map();
  for (const o of options) {
    const name = o.grp || o.label;
    if (!byName.has(name)) byName.set(name, { name, named: Boolean(o.grp), options: [] });
    byName.get(name).options.push(o);
  }
  return [...byName.values()].map((g) => ({
    ...g,
    total: g.options.length,
    taken: g.options.filter((o) => o.taken).length,
  }));
}

/**
 * `tile` is a row from tiles_for_me(). Returns what to draw and whether the
 * next submit finishes the tile.
 *
 * `staged` is how much is about to be submitted but is not in the database yet
 * — points for a sum rule, a list of option ids for a set rule — so the button
 * can read "Submit & fire" before the round trip rather than after it.
 */
export function tileProgress(tile, staged = {}) {
  const rule = tile.completion ?? 'points';
  const options = tile.options ?? [];
  const need = tile.required_evidence ?? 1;
  const perSet = tile.per_set ?? 1;
  const stagedIds = new Set(staged.optionIds ?? []);
  const stagedPoints = staged.points ?? 0;

  if (rule === 'one_set' || rule === 'each_set') {
    // A staged option counts toward its group, but only once: two screenshots
    // of the same piece are still one piece, which is the rule these tiles
    // exist to express.
    const groups = tileGroups(options).map((g) => {
      const taken = g.options.filter((o) => o.taken || stagedIds.has(o.id)).length;
      return { ...g, taken, need: rule === 'one_set' ? g.total : Math.min(perSet, g.total) };
    });
    const complete = groups.filter((g) => g.taken >= g.need);

    if (rule === 'one_set') {
      // The set closest to finished, so the counter tracks the one the team is
      // actually working on rather than whichever happens to be first.
      const best = groups.reduce(
        (b, g) => (!b || g.need - g.taken < b.need - b.taken || (g.need - g.taken === b.need - b.taken && g.taken > b.taken) ? g : b),
        null
      );
      return {
        rule, groups,
        done: complete.length > 0,
        unit: best?.named ? `Best set (${best.name})` : 'Best set',
        have: best?.taken ?? 0,
        need: best?.need ?? 0,
      };
    }

    return {
      rule, groups,
      done: groups.length > 0 && complete.length === groups.length,
      unit: perSet > 1 ? 'Sets complete' : 'Collected',
      have: complete.length,
      need: groups.length,
    };
  }

  // An unpriced tile banks a point per screenshot, so its count and its point
  // total are the same number — but only `evidence_count` is filled in for one,
  // so read whichever the tile actually has.
  const have = rule === 'value' || options.length > 0
    ? (tile.evidence_points ?? 0)
    : (tile.evidence_count ?? 0);

  return {
    rule,
    groups: tileGroups(options),
    done: have + stagedPoints >= need,
    unit: rule === 'value' ? 'Value' : (options.length > 0 ? 'Points' : 'Evidence'),
    suffix: rule === 'value' ? 'm' : '',
    have,
    need,
    staged: stagedPoints,
  };
}
