/**
 * The scoreboard. Everything here is derived by the `team_scores` function, so there
 * is no running total anywhere that could drift out of step with the board.
 *
 * It shows both teams, deliberately. Every hit is already public in the event
 * feed, and one hit is exactly one point, so this reveals nothing new.
 */
export default function Scoreboard({ scores, myTeamId }) {
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
            </div>
            <div className="points">{s.total}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}
