import { useMemo, useState } from 'react';
import { useGameStats } from '../hooks/useGameStats.js';
import { STAT_DEFS, DEFAULT_STAT_IDS, computeStats } from '../lib/stats.js';

const STORAGE_KEY = 'hs-battleships:stats-shown';

function loadShown() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set(DEFAULT_STAT_IDS);
    return new Set(JSON.parse(raw));
  } catch {
    return new Set(DEFAULT_STAT_IDS);
  }
}

/**
 * Per-game/per-player stats, alongside the scoreboard rather than replacing
 * it — the scoreboard is the score, this is everything else. Which rows show
 * is a per-browser preference (not every stat matters for every event), kept
 * in localStorage since there is nowhere server-side that a display
 * preference like this belongs.
 */
export default function StatsPanel({ gameId, teams, myTeamId }) {
  const { events, profiles, loading } = useGameStats(gameId);
  const [shown, setShown] = useState(loadShown);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const stats = useMemo(
    () => computeStats(events, teams, profiles),
    [events, teams, profiles]
  );

  function toggle(id) {
    setShown((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  const teamStats = STAT_DEFS.filter((d) => d.scope === 'team' && shown.has(d.id));
  const showTopShooters = shown.has('topShooters');
  const showTopClaimers = shown.has('topClaimers');

  // Mine first, so a glance at the card reads "us, then them".
  const orderedTeams = [...stats.teamRows].sort((a, b) =>
    (a.teamId === myTeamId ? -1 : 0) - (b.teamId === myTeamId ? -1 : 0));

  return (
    <section className="stats-panel" id="stats-panel-section">
      <h2>
        Stats
        <button className="link stats-toggle" onClick={() => setSettingsOpen((s) => !s)}>
          {settingsOpen ? 'done' : 'edit'}
        </button>
      </h2>

      {settingsOpen && (
        <ul className="stats-settings">
          {STAT_DEFS.map((d) => (
            <li key={d.id}>
              <label>
                <span>{d.label}</span>
                <input
                  type="checkbox"
                  checked={shown.has(d.id)}
                  onChange={() => toggle(d.id)}
                />
              </label>
            </li>
          ))}
        </ul>
      )}

      {loading && <p className="muted">Loading…</p>}

      {!loading && teamStats.length > 0 && (
        <table className="stats-table">
          <thead>
            <tr>
              <th />
              {orderedTeams.map((t) => (
                <th key={t.teamId} className={t.teamId === myTeamId ? 'mine' : ''}>{t.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {teamStats.map((d) => (
              <tr key={d.id}>
                <th>{d.label}</th>
                {orderedTeams.map((t) => (
                  <td key={t.teamId} className={t.teamId === myTeamId ? 'mine' : ''}>{t[d.id]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!loading && showTopShooters && stats.topShooters.length > 0 && (
        <div className="stats-list">
          <h3>Top shooters</h3>
          <ol>
            {stats.topShooters.map((p) => (
              <li key={p.uid}>{p.name} — {p.shots} shots, {p.hits} hits ({p.accuracy})</li>
            ))}
          </ol>
        </div>
      )}

      {!loading && showTopClaimers && stats.topClaimers.length > 0 && (
        <div className="stats-list">
          <h3>Most tiles claimed</h3>
          <ol>
            {stats.topClaimers.map((p) => (
              <li key={p.uid}>{p.name} — {p.count}</li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
