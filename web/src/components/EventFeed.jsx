import { fromPosition, coordLabel } from '../lib/board.js';

/**
 * The live feed. Note it never names a tile: `game_events` deliberately carries
 * only `tile_id` and `position`, because the feed is readable by both teams and
 * the tile grid is shared. Your own tiles get their names from `tiles_for_me`.
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
      case 'game_started':
        return 'The game has begun — fleets are locked.';
      case 'tile_claimed':
        return `${who} claimed a tile${at ? ` at ${at}` : ''}.`;
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
