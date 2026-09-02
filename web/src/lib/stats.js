// Pure stat computation from a game's full event history. Kept separate from
// the hook that fetches the events, so it's trivial to test/reason about and
// so recomputation is just "call this again with a new array", which is all
// useMemo needs to skip the work when the events reference hasn't changed.

/**
 * The catalog of rows a player can choose to show. Not every stat means
 * something for every event set, so this is a menu rather than a fixed list.
 */
export const STAT_DEFS = [
  { id: 'shotsFired', label: 'Shots fired', scope: 'team' },
  { id: 'hits', label: 'Hits', scope: 'team' },
  { id: 'misses', label: 'Misses', scope: 'team' },
  { id: 'accuracy', label: 'Accuracy', scope: 'team' },
  { id: 'tilesClaimed', label: 'Tiles claimed', scope: 'team' },
  { id: 'shipsSunk', label: 'Ships sunk', scope: 'team' },
  { id: 'topShooters', label: 'Top shooters', scope: 'player' },
  { id: 'topClaimers', label: 'Most tiles claimed', scope: 'player' },
];

export const DEFAULT_STAT_IDS = ['shotsFired', 'hits', 'accuracy', 'shipsSunk'];

function pct(n, d) {
  if (!d) return '—';
  return `${Math.round((n / d) * 100)}%`;
}

/**
 * `events` — the full, unfiltered game_events history (not the 50-row page
 * used for the activity feed). `teams` — [{id, name}]. `profiles` — a
 * {id: display_name} map, for attributing `payload.by` on a couple of event
 * types to a person.
 */
export function computeStats(events, teams, profiles) {
  const perTeam = new Map(teams.map((t) => [t.id, {
    teamId: t.id, name: t.name, shotsFired: 0, hits: 0, misses: 0,
    tilesClaimed: 0, shipsSunk: 0,
  }]));
  const shotsByPlayer = new Map();  // uid -> { shots, hits }
  const claimsByPlayer = new Map(); // uid -> count

  for (const e of events) {
    const team = perTeam.get(e.team_id);
    const by = e.payload?.by;

    if (e.type === 'shot_fired') {
      if (team) {
        team.shotsFired += 1;
        if (e.payload?.result === 'hit') team.hits += 1; else team.misses += 1;
      }
      if (by) {
        const row = shotsByPlayer.get(by) ?? { shots: 0, hits: 0 };
        row.shots += 1;
        if (e.payload?.result === 'hit') row.hits += 1;
        shotsByPlayer.set(by, row);
      }
    } else if (e.type === 'tile_claimed') {
      if (team) team.tilesClaimed += 1;
      if (by) claimsByPlayer.set(by, (claimsByPlayer.get(by) ?? 0) + 1);
    } else if (e.type === 'ship_sunk') {
      if (team) team.shipsSunk += 1;
    }
  }

  const teamRows = [...perTeam.values()].map((t) => ({
    ...t, accuracy: pct(t.hits, t.shotsFired),
  }));

  const name = (uid) => profiles?.[uid] ?? 'Someone';

  const topShooters = [...shotsByPlayer.entries()]
    .map(([uid, r]) => ({ uid, name: name(uid), shots: r.shots, hits: r.hits, accuracy: pct(r.hits, r.shots) }))
    .sort((a, b) => b.shots - a.shots)
    .slice(0, 5);

  const topClaimers = [...claimsByPlayer.entries()]
    .map(([uid, count]) => ({ uid, name: name(uid), count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return { teamRows, topShooters, topClaimers };
}
