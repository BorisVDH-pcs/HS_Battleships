import { useEffect, useState } from 'react';
import { signedUrls } from '../lib/evidence.js';

/**
 * What has been submitted for one tile.
 *
 * Shared by the organiser's board and a team's own, because the question is the
 * same from both sides — "what did we send for this?" — and only the gate
 * differs. A team's rows come from my_evidence(), which is scoped to their own
 * teams; an organiser's come from admin_list_evidence(), which is not. Neither
 * decision is made here.
 *
 * Signed URLs are minted for the open tile only, rather than for every piece of
 * evidence in the game up front. They expire, so a panel left open all evening
 * would otherwise quietly stop showing images.
 */
export default function EvidencePanel({ title, coord, meta, items, onClose }) {
  const [urls, setUrls] = useState({});
  const [error, setError] = useState(null);

  const paths = items.map((e) => e.storage_path).join('\n');

  useEffect(() => {
    let cancelled = false;
    const list = paths ? paths.split('\n') : [];
    if (!list.length) { setUrls({}); return; }
    signedUrls(list)
      .then((map) => { if (!cancelled) { setUrls(map); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [paths]);

  return (
    <div className="tile-evidence-panel">
      <div className="panel-head">
        <h3>
          {title}
          {coord && <span className="coord"> {coord}</span>}
        </h3>
        <button className="ghost" onClick={onClose}>Close</button>
      </div>
      {meta && <p className="muted">{meta}</p>}
      {error && <p className="error">{error}</p>}

      {items.length === 0 ? (
        <p className="muted">Nothing submitted for this tile yet.</p>
      ) : (
        <ul className="evidence-review">
          {items.map((e) => (
            <li key={e.id}>
              <a href={urls[e.storage_path]} target="_blank" rel="noreferrer">
                {urls[e.storage_path]
                  ? <img src={urls[e.storage_path]} alt="" loading="lazy" />
                  : <span className="evidence-pending" />}
              </a>
              <div className="meta">
                <strong>{e.uploaded_by_name}</strong>
                <span className="muted">{new Date(e.created_at).toLocaleString()}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
