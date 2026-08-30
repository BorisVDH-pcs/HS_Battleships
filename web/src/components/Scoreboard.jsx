/**
 * The scoreboard. Everything here is derived by the `team_scores` function, so there
 * is no running total anywhere that could drift out of step with the board.
 *
 * It shows both teams, deliberately. Tiles fired, hits and sinkings are already
 * public — `game_events` broadcasts every shot and its result — so a total built
 * from them reveals nothing new. What it does NOT expose is the `reason`
 * on a manual adjustment, which is free text an admin types and could name a
 * tile. Those stay behind RLS, readable only by the team they concern.
 */
export default function Scoreboard({ scores, myTeamId, game }) {
  if (!scores || scores.length === 0) return null;

  const ranked = [...scores].sort(
    (a, b) => b.total - a.total || a.team_name.localeCompare(b.team_name)
  );
  const drawn = ranked.length > 1 && ranked[0].total === ranked[1].total;

  return (
    <section className="scoreboard">
      <h2>Score</h2>
      <ul>
        {ranked.map((s, i) => (
          <li
            key={s.team_id}
            className={[
              s.team_id === myTeamId ? 'mine' : '',
              i === 0 && !drawn ? 'leading' : '',
            ].filter(Boolean).join(' ')}
          >
            <div className="who">
              <strong>{s.team_name}</strong>
              {s.team_id === myTeamId && <span className="tag">you</span>}
              <div className="meta">{breakdown(s)}</div>
            </div>
            <div className="points">{s.total}</div>
          </li>
        ))}
      </ul>
      <p className="muted">{weights(game)}</p>
    </section>
  );
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Hits and sinkings are shown whether or not they score — they are the game. */
function breakdown(s) {
  const parts = [
    plural(s.tiles_fired, 'tile'),
    plural(s.hits, 'hit'),
    `${s.ships_sunk} sunk`,
  ];
  if (s.adjustments) {
    parts.push(`${s.adjustments > 0 ? '+' : ''}${s.adjustments} manual`);
  }
  return parts.join(' · ');
}

function weights(game) {
  if (!game) return '';
  const parts = [];
  if (game.points_per_tile) parts.push(`${plural(game.points_per_tile, 'point')} per tile completed`);
  if (game.points_per_hit)  parts.push(`${plural(game.points_per_hit, 'point')} per hit`);
  if (game.points_per_sink) parts.push(`${plural(game.points_per_sink, 'point')} per ship sunk`);
  return parts.length ? parts.join(', ') + '.' : 'No points are being awarded automatically.';
}
