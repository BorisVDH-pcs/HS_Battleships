import { millionsLabel } from './millions.js';

/** Describe a team-private evidence event without treating every rule as points. */
export function evidenceEventText(payload = {}, fallbackWho = 'Someone') {
  const by = payload.uploaded_by_name ?? fallbackWho;
  const tile = payload.tile_name ?? 'a tile';
  const need = payload.required_evidence;
  const rule = payload.completion ?? 'points';

  // Every per-group rule stops at naming the drop. The running total below is
  // a fraction of the tile's target, and a tile whose target is per-group does
  // not have one to be a fraction of.
  const perGroup = rule === 'one_set' || rule === 'each_set' || rule === 'points_per_set';

  if (perGroup && payload.option_label) {
    return `${by} submitted ${payload.option_label} for ${tile}.`;
  }
  if (rule === 'value') {
    // Every number in a value event is in tenths of a million, including the
    // target — see lib/millions.js.
    return `${by} submitted a drop worth ${millionsLabel(payload.points_awarded)}m for ${tile} ` +
      `(${millionsLabel(payload.points_total)}/${millionsLabel(need)}m).`;
  }
  if (payload.option_label) {
    return `${by} submitted ${payload.option_label} for ${tile} — ` +
      `${payload.points_awarded} points (${payload.points_total}/${need}).`;
  }
  return `${by} submitted proof for ${tile} (${payload.evidence_count}/${need}).`;
}
