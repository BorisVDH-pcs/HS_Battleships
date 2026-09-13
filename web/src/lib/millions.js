/**
 * Value tiles, and the half million.
 *
 * A `value` tile is scored on what the submitter says a drop was worth, in
 * millions, and until now that number was a whole one: `add_evidence` took an
 * int and `tile_evidence.points` is an integer column. That was fine for the
 * tiles it was built for -- 250m in raid uniques -- and wrong for the first
 * tile with something cheap on the list. A revenant Ancient emblem is worth
 * exactly 500,000, and "15m in artefacts" that cannot count a half million is
 * a tile with a hole in the middle of it.
 *
 * So the stored unit is now a TENTH of a million, everywhere: `p_amount`,
 * `tile_evidence.points` and a value tile's `required_evidence`. Nothing in
 * the database is a fraction -- 0.5m is 5, 15m is 150 -- and nothing outside
 * this module needs to know that, because every screen that shows one of those
 * numbers goes through here.
 *
 * A tenth, rather than a hundredth: it covers the half million that prompted
 * this and every artefact tier above it, and it keeps a 1000m target inside
 * `smallint` (10,000) with room to spare. If a tile ever needs 50k precision
 * this is the one place that changes.
 */

/** What one million is worth in stored units. */
export const PER_MILLION = 10;

/** Stored tenths -> millions, as a number. `145` -> `14.5`. */
export const toMillions = (tenths) => (tenths ?? 0) / PER_MILLION;

/**
 * Stored tenths -> millions, as text for a screen. Whole numbers stay whole,
 * so a 250m tile does not suddenly read "250.0m".
 */
export function millionsLabel(tenths) {
  const n = toMillions(tenths);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * What someone typed -> stored tenths, or null if it is not a value.
 *
 * Both separators are accepted on purpose. The people using this write 0,5 as
 * often as 0.5, and a decimal comma silently parsing as 0 -- which is what
 * `parseFloat('0,5')` does -- would hand a team nothing for a real drop and
 * look like the site losing their evidence.
 *
 * One decimal place, because a tenth is the whole precision of the stored
 * unit. `0.55` is refused rather than rounded: a number quietly turned into a
 * different number is worse than a number the box would not take.
 */
export function millionsToTenths(text) {
  const cleaned = String(text ?? '').trim().replace(',', '.');
  if (!/^\d{1,4}(\.\d)?$/.test(cleaned)) return null;
  const tenths = Math.round(parseFloat(cleaned) * PER_MILLION);
  return Number.isFinite(tenths) ? tenths : null;
}

/** The smallest and largest a single typed value may be, in stored tenths. */
export const MIN_VALUE = 1;          // 0.1m
export const MAX_VALUE = 10000;      // 1000m
