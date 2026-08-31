import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase.js';
import { signedUrls } from '../lib/evidence.js';
import { coordLabel, fromPosition } from '../lib/board.js';

/**
 * The organiser's read of every piece of evidence in a game.
 *
 * There is no approve or reject here on purpose: uploading is what unlocks the
 * shot, and the game does not stop to wait on a queue mid-event. This exists so
 * that a disputed tile can be settled by looking, and so a team that is inventing
 * completions can be caught. Nothing on this screen is destructive.
 *
 * It names the tile and the team side by side, which is exactly what a player
 * must never see across the line — admin_list_evidence() refuses anyone who is
 * not an admin, so this is gated at the database, not by hiding the component.
 */
export default function EvidenceReview({ gameId }) {
  const [rows, setRows] = useState([]);
  const [urls, setUrls] = useState({});
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!gameId) { setRows([]); return; }
    let cancelled = false;
    setLoading(true);
    supabase
      .rpc('admin_list_evidence', { p_game_id: gameId })
      .then(({ data, error: err }) => {
        if (cancelled) return;
        if (err) { setError(err.message); return; }
        setRows(data ?? []);
        return signedUrls((data ?? []).map((r) => r.storage_path)).then((map) => {
          if (!cancelled) setUrls(map);
        });
      })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [gameId]);

  if (error) return <p className="error">{error}</p>;
  if (loading) return <p className="muted">Loading evidence…</p>;
  if (!rows.length) return <p className="muted">No evidence submitted yet.</p>;

  return (
    <ul className="evidence-review">
      {rows.map((r) => {
        const { row, col } = fromPosition(r.tile_position);
        return (
          <li key={r.id}>
            <a href={urls[r.storage_path]} target="_blank" rel="noreferrer">
              {urls[r.storage_path]
                ? <img src={urls[r.storage_path]} alt="" loading="lazy" />
                : <span className="evidence-pending" />}
            </a>
            <div className="meta">
              <strong>{r.tile_name}</strong>
              <span className="coord">{coordLabel(row, col)}</span>
              <span className="muted">
                {r.team_name} · {r.uploaded_by_name} ·{' '}
                {new Date(r.created_at).toLocaleString()}
                {r.status === 'fired' ? ' · fired' : ' · not yet fired'}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
