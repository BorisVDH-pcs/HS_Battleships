// How far along a claimed tile is, under whichever rule it uses (0049).
//
// One module because three places need the same answer and must not disagree:
// the card's counter, the picker that decides when Submit becomes "Submit &
// fire", and the "?" panel that shows the sets filling up. The database is
// still the authority — claim_is_complete() decides whether a shot actually
// goes off — but the interface has to predict it correctly or the button lies.
//
// The rules, mirroring the migration:
//   points         sum the points of what was submitted; repeats count.
//   value          same sum, except the numbers were typed by the submitter.
//   one_set        finished when any ONE group is complete.
//   each_set       finished when EVERY group has `per_set` distinct options.
//   points_per_set finished when EVERY group has `per_set` points in it, and
//                  the same drop handed in twice is worth twice.
//
// An option with no `grp` is its own group, which is what makes "one from each
// of five bosses" and "two different pieces of one set" the same mechanism.
//
// Cutting across all five, an option may carry `max_times`: how often that one
// drop may count. Null is unlimited, which is what every option was before the
// column existed. It belongs to the option rather than the rule, so a capped
// drop closes under `points` exactly as it does under `points_per_set`, and
// the set rules — where a repeat was already worth nothing — are unaffected.
//
// The last two rules are a pair, and the difference between them is the only
// thing either is for: `each_set` is "two DIFFERENT uniques from each boss",
// `points_per_set` is "two uniques from each boss" with no such qualifier. So
// they group identically and diverge on one question — does a repeat count.

/**
 * Do this tile's prices say anything worth printing?
 *
 * Only when the drops are not all worth the same one point. A tile whose every
 * drop is worth 1 is scored in screenshots wearing a points hat: the counter
 * already reads "2 / 3", and hanging "— 1 pts" off every line of the list adds
 * a number that is the same on every line and equal to the one above it.
 *
 * The question has to be asked of the TILE, never of the single option. On a
 * mixed list "1 pt" is real information — it says this drop is the cheap one —
 * and hiding it there would leave the reader to infer a price from the absence
 * of a price. So: all the same and that same is one, or nothing is hidden.
 *
 * Asked in three places — the player's picker, the "?" panel and the builder's
 * preview of both — which is exactly why it lives here rather than three times
 * over as a condition each of them gets to word slightly differently.
 */
export function tileShowsPrices(tile) {
  const options = tile.options ?? [];
  return options.some((option) => (option.points ?? 1) !== 1);
}

/** "1 pt", "3 pts". */
export const pointsLabel = (n) => `${n} pt${n === 1 ? '' : 's'}`;

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
  const stagedList = staged.optionIds ?? [];
  const stagedIds = new Set(stagedList);
  const stagedPoints = staged.points ?? 0;

  // Points banked into one group, counting repeats: what `points_per_set`
  // measures and the one number no boolean `taken` can carry. `got` is the
  // per-option submission count from tiles_for_me(); the fallback keeps this
  // honest for any caller still handing over the older boolean-only shape.
  if (rule === 'points_per_set') {
    const worth = (o) => o.points ?? 1;
    // Clamped to the option's cap, as claim_is_complete() clamps it: a drop
    // past its limit is not worth anything, so counting it here would draw a
    // group as full that the server will not accept as full.
    const counted = (o, list) => Math.min(timesUsed(o, list), o.max_times ?? Infinity);
    const groups = tileGroups(options).map((g) => {
      const banked = g.options.reduce((sum, o) => sum + counted(o, []) * worth(o), 0);
      const adding = g.options.reduce(
        (sum, o) => sum + (counted(o, stagedList) - counted(o, [])) * worth(o), 0
      );
      return { ...g, taken: banked + adding, need: perSet };
    });
    const complete = groups.filter((g) => g.taken >= g.need);

    // One group means "this many points from this list", and calling that
    // 0/1 sets would hide the target the tile is actually about — the same
    // reason each_set special-cases a lone group.
    if (groups.length === 1) {
      const [group] = groups;
      return {
        rule, groups,
        done: group.taken >= group.need,
        unit: 'Points',
        have: group.taken,
        need: group.need,
      };
    }

    return {
      rule, groups,
      done: groups.length > 0 && complete.length === groups.length,
      unit: 'Sets complete',
      have: complete.length,
      need: groups.length,
    };
  }

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

    // A single group with a quota means "choose N different items from this
    // list". Showing 0/1 sets hides that quota and makes a two-item tile look
    // one item long, so count the distinct items directly in this shape.
    if (groups.length === 1) {
      const [group] = groups;
      return {
        rule, groups,
        done: group.taken >= group.need,
        unit: 'Items',
        have: group.taken,
        need: group.need,
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

/**
 * How many times a drop has been handed in, counting what is staged.
 *
 * `got` is the per-option submission count from tiles_for_me(); the fallback
 * keeps this honest for any caller still handing over the older boolean-only
 * shape, where the most a `taken` can tell us is "at least one".
 */
const timesUsed = (option, stagedList = []) =>
  (option.got ?? (option.taken ? 1 : 0))
  + stagedList.filter((id) => id === option.id).length;

/**
 * Options that cannot be selected for another screenshot.
 *
 * Three reasons a drop closes, and they stack:
 *
 *   * it has hit its own `max_times` cap, which is a property of the OPTION
 *     and so applies under every rule — including plain `points`, the only
 *     rule where this function used to have nothing to say;
 *   * it is an exact duplicate on a rule where a repeat is worth nothing;
 *   * its group is finished, so nothing from that group can move the tile.
 *
 * The server refuses all three, so offering them would only produce an error
 * after the upload had already cost the player a round trip.
 */
export function unavailableSetOptionIds(tile, staged = {}) {
  const rule = tile.completion ?? 'points';
  const stagedList = staged.optionIds ?? [];
  const unavailable = new Set();

  // The cap first, and for every rule. A capped drop that has run out is
  // spent whether or not the tile groups anything.
  for (const option of tile.options ?? []) {
    if (option.max_times != null && timesUsed(option, stagedList) >= option.max_times) {
      unavailable.add(option.id);
    }
  }

  // Under `points_per_set` a repeat is the whole feature, so nothing else
  // closes except a group that has reached its target — at which point further
  // drops from that boss cannot move the tile and offering them would mislead.
  if (rule === 'points_per_set' || rule === 'each_set') {
    for (const group of tileProgress(tile, staged).groups) {
      if (group.taken >= group.need) {
        for (const option of group.options) unavailable.add(option.id);
      }
    }
  }

  if (rule === 'one_set' || rule === 'each_set') {
    for (const option of tile.options ?? []) {
      if (option.taken) unavailable.add(option.id);
    }
    for (const id of stagedList) unavailable.add(id);
  }

  return unavailable;
}

/** Names of per-group sets whose persisted evidence already meets the quota. */
export function completedEachSetGroupNames(tile) {
  const rule = tile.completion ?? 'points';
  if (rule !== 'each_set' && rule !== 'points_per_set') return new Set();

  return new Set(
    tileProgress(tile).groups
      .filter((group) => group.taken >= group.need)
      .map((group) => group.name)
  );
}

/**
 * Play a list of picks into a fresh claim and report what this module thinks
 * happens — the browser's half of the builder's tile tester.
 *
 * The server runs the same list through `claim_is_complete()` and the builder
 * shows both answers. That is the entire point: this file is a MIRROR of the
 * database's rules, kept in step by hand, so a tester that only asked the
 * mirror would be asking whether the mirror agrees with itself. Two answers
 * side by side turn a silent drift into a visible one.
 *
 * A pick the picker would not have offered is skipped rather than banked,
 * because a player could not have submitted it either: that is what
 * `unavailableSetOptionIds` decides, and reusing it here is what keeps this
 * replay honest about the interface it is predicting.
 *
 * `picks` is the same shape the RPC takes — `{ optionId }`, `{ amount }`, or
 * `{}` — so the builder can hand the one list to both.
 */
export function replayTile(tile, picks = []) {
  const rule = tile.completion ?? 'points';
  const isSet = rule === 'one_set' || rule === 'each_set';
  const isValue = rule === 'value';

  let state = {
    ...tile,
    evidence_points: 0,
    evidence_count: 0,
    options: (tile.options ?? []).map((o) => ({ ...o, got: 0, taken: false })),
  };

  let accepted = 0;
  let points = 0;
  let completedAtStep = null;

  picks.forEach((pick, index) => {
    const optionId = pick.optionId ?? null;

    if (optionId && unavailableSetOptionIds(state).has(optionId)) return;

    const option = state.options.find((o) => o.id === optionId);
    if (optionId && !option) return;
    if (!isValue && state.options.length > 0 && !option) return;

    const award = isValue
      ? (parseInt(pick.amount, 10) || 0)
      : option
        ? (isSet ? 1 : (option.points ?? 1))
        : 1;
    if (isValue && (award < 1 || award > 1000)) return;

    state = {
      ...state,
      evidence_points: state.evidence_points + award,
      evidence_count: state.evidence_count + 1,
      options: state.options.map((o) => (
        o.id === optionId ? { ...o, got: (o.got ?? 0) + 1, taken: true } : o
      )),
    };
    accepted += 1;
    points += award;

    if (completedAtStep === null && tileProgress(state).done) {
      completedAtStep = index + 1;
    }
  });

  return {
    complete: completedAtStep !== null,
    completedAtStep,
    points,
    accepted,
    skipped: picks.length - accepted,
    // The card's counter after the last submission, so the builder can draw
    // the same line the player would be looking at rather than inventing a
    // second wording for the same numbers.
    progress: tileProgress(state),
    // The tile as `tiles_for_me()` would have returned it after those
    // submissions — `got` and `taken` filled in on every option. A real
    // player's card, "?" panel and drop picker all read one row like this, so
    // handing the builder the same shape is what lets its preview behave like
    // the interface rather than like a description of it.
    state,
  };
}

/** A compact progress line for places which do not render the full uploader. */
export function tileProgressText(tile) {
  const progress = tileProgress(tile);
  if (progress.rule === 'one_set') {
    return `${progress.unit} ${progress.have}/${progress.need}`;
  }
  if (progress.rule === 'each_set') {
    return progress.unit === 'Items'
      ? `${progress.have}/${progress.need} items collected`
      : `${progress.have}/${progress.need} sets complete`;
  }
  if (progress.rule === 'points_per_set') {
    return progress.unit === 'Points'
      ? `${progress.have}/${progress.need} pts`
      : `${progress.have}/${progress.need} sets complete`;
  }
  if (progress.rule === 'value') {
    return `${progress.have}/${progress.need}m`;
  }
  if ((tile.options ?? []).length > 0) {
    return `${progress.have}/${progress.need} pts`;
  }
  return `${progress.have}/${progress.need} submitted`;
}
