import { fromPosition, coordLabel } from '../lib/board.js';

/**
 * The live feed. Most event types never name a tile: `game_events` is readable
 * by both teams, and the tile grid is shared, so those payloads deliberately
 * carry only `tile_id`/`position`. `evidence_submitted` and `slot_freed` are the
 * exception — the database RLS policy on `game_events` only lets a team read
 * its own rows of those two types (see migration 0035), so by the time one
 * reaches this component it is safe to show the tile name.
 */
export default function EventFeed({ events, teams, myTeamId }) {
  const teamName = (id) => teams.find((t) => t.id === id)?.name ?? 'Someone';

  function describe(e) {
    const who = teamName(e.team_id);
    const mine = e.team_id === myTeamId;
    const at = e.payload?.position
      ? coordLabel(fromPosition(e.payload.position).row, fromPosition(e.payload.position).col)
      : null;

    switch (e.type) {
      case 'fleet_placed':
        // Hull count only — the payload deliberately carries no cells.
        return `${who}'s fleet is set.`;
      case 'team_renamed':
        return `${e.payload?.old_name ?? 'A team'} is now ${e.payload?.new_name ?? who}.`;
      case 'game_started':
        return 'The game has begun — fleets are locked.';
      case 'tile_claimed':
        return `${who} locked in a tile${at ? ` at ${at}` : ''}.`;
      case 'claim_released':
        // Says an organiser did it, because a tile going back on the board with
        // no explanation reads like a bug to whoever is watching the feed.
        return `An admin released ${who}'s tile${at ? ` at ${at}` : ''}.`;
      case 'shot_fired':
        return `${who} fired${at ? ` at ${at}` : ''} — ${e.payload?.result === 'hit' ? 'HIT' : 'miss'}.`;
      case 'ship_sunk':
        return `${who} sank a ${e.payload?.size}-tile ship!`;
      case 'game_won':
        return `${who} wins — the enemy fleet is gone.`;
      case 'game_reset':
        return e.payload?.fleets_cleared
          ? 'The game has been reset — fleets need placing again.'
          : 'The game has been reset. Fleets are unchanged.';
      case 'score_adjusted': {
        // The delta only. The admin's reason is deliberately not in the payload:
        // it is free text and could name a tile on the shared grid.
        const d = e.payload?.delta ?? 0;
        const points = `${Math.abs(d)} point${Math.abs(d) === 1 ? '' : 's'}`;
        if (e.payload?.reverted) return `An adjustment to ${who} was reverted.`;
        return `${who} ${d >= 0 ? 'gained' : 'lost'} ${points}.`;
      }
      case 'evidence_submitted':
        return `${e.payload?.uploaded_by_name ?? who} submitted proof for ` +
          `${e.payload?.tile_name ?? 'a tile'} (${e.payload?.evidence_count}/${e.payload?.required_evidence}) — ` +
          `${e.payload?.tiles_left_to_fire} tile(s) left to fire.`;
      case 'slot_freed':
        return 'A slot is free to claim.';
      default:
        return e.type;
    }
  }

  return (
    <section className="feed">
      <h2>Activity</h2>
      <ul>
        {events.map((e) => (
          <li key={e.id} className={e.team_id === myTeamId ? 'mine' : 'theirs'}>
            <time>{new Date(e.created_at).toLocaleTimeString()}</time>
            <span>{describe(e)}</span>
          </li>
        ))}
        {events.length === 0 && <li className="muted">Nothing has happened yet.</li>}
      </ul>
    </section>
  );
}
