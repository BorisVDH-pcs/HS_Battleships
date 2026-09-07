import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
 *
 * ---- why it pages, and why it signs a page at a time ----
 *
 * The bucket is private, so every image needs a signed URL, and those expire
 * after an hour. This screen used to mint one for every row in the game the
 * moment it mounted and never mint another — which fails twice over. A game's
 * worth of screenshots is several hundred full-size images rendered at once,
 * and an organiser who leaves the tab open through an event (which is what
 * this tab is for) comes back after the hour to a screen of broken images and
 * no reason given. EvidencePanel had this right for one tile and said so in a
 * comment; this is the same lesson applied to the list.
 *
 * So: the rows are fetched once — the metadata is small and it is what the
 * filters are built from — and only the page on screen is ever signed. Coming
 * back to a stale tab re-signs it.
 *
 * The filters are the other half of the same problem. The screen exists to
 * settle a dispute, and a dispute is about one tile; scrolling a whole event
 * to find it is not reading, it is searching by eye.
 */

/** Rows per page. Enough to scan, few enough to sign and paint at once. */
const PAGE = 30;

/**
 * When a page's URLs are old enough to be worth replacing.
 *
 * Under the hour they are minted for, with room to spare: the check runs when
 * the tab is looked at, so it has to be comfortably early rather than exactly
 * right — a URL that expires two minutes after the check passes is still a
 * broken image.
 */
const RESIGN_AFTER_MS = 45 * 60 * 1000;

export default function EvidenceReview({ gameId }) {
  const [rows, setRows] = useState([]);
  const [urls, setUrls] = useState({});
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const [team, setTeam] = useState('');
  const [player, setPlayer] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);

  const mintedAt = useRef(0);
  // Bumped per signing run, so a slow reply for a page already left cannot
  // paint its URLs over the page now on screen.
  const signSeq = useRef(0);

  useEffect(() => {
    if (!gameId) { setRows([]); return undefined; }
    let cancelled = false;
    setLoading(true);
    supabase
      .rpc('admin_list_evidence', { p_game_id: gameId })
      .then(({ data, error: err }) => {
        if (cancelled) return;
        if (err) { setError(err.message); return; }
        setRows(data ?? []);
        setError(null);
      })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [gameId]);

  const teams = useMemo(
    () => [...new Set(rows.map((r) => r.team_name).filter(Boolean))].sort(),
    [rows]
  );
  const players = useMemo(
    () => [...new Set(rows.map((r) => r.uploaded_by_name).filter(Boolean))].sort(),
    [rows]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (team && r.team_name !== team) return false;
      if (player && r.uploaded_by_name !== player) return false;
      if (!q) return true;
      // The coordinate is searched as well as the name, because a dispute
      // arrives as "what did they send for H7", not as a tile's wording.
      const { row, col } = fromPosition(r.tile_position);
      return `${r.tile_name ?? ''} ${coordLabel(row, col)}`.toLowerCase().includes(q);
    });
  }, [rows, team, player, query]);

  // A filter narrowing the list under a page you had scrolled to would leave
  // you on an empty page 4 of 1.
  useEffect(() => { setPage(0); }, [team, player, query]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE));
  const shown = filtered.slice(page * PAGE, page * PAGE + PAGE);

  // The identity of what is on screen, as a plain string so the effect below
  // re-runs on a genuine change of page rather than on every render.
  const pageKey = shown.map((r) => r.storage_path).join('\n');

  const sign = useCallback(async (paths) => {
    if (!paths.length) { setUrls({}); return; }
    const seq = ++signSeq.current;
    try {
      const map = await signedUrls(paths);
      if (seq !== signSeq.current) return;
      setUrls(map);
      mintedAt.current = Date.now();
      setError(null);
    } catch (e) {
      if (seq === signSeq.current) setError(e.message);
    }
  }, []);

  useEffect(() => {
    sign(pageKey ? pageKey.split('\n') : []);
  }, [pageKey, sign]);

  // Coming back to a tab that has been open past the expiry. Same pair of
  // listeners the board uses, and for the same reason: only visibilitychange
  // covers a phone unlocking, only focus covers a desktop alt-tab.
  useEffect(() => {
    if (!pageKey) return undefined;
    const recheck = () => {
      if (document.hidden) return;
      if (Date.now() - mintedAt.current < RESIGN_AFTER_MS) return;
      sign(pageKey.split('\n'));
    };
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', recheck);
    return () => {
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', recheck);
    };
  }, [pageKey, sign]);

  if (error) return <p className="error">{error}</p>;
  if (loading) return <p className="muted">Loading evidence…</p>;
  if (!rows.length) return <p className="muted">No evidence submitted yet.</p>;

  const filtering = Boolean(team || player || query.trim());

  return (
    <>
      <div className="evidence-filters">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Tile name or square"
          aria-label="Filter by tile"
        />
        <select value={team} onChange={(e) => setTeam(e.target.value)} aria-label="Filter by team">
          <option value="">Both teams</option>
          {teams.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={player} onChange={(e) => setPlayer(e.target.value)} aria-label="Filter by player">
          <option value="">Everyone</option>
          {players.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        {filtering && (
          <button
            className="ghost"
            onClick={() => { setTeam(''); setPlayer(''); setQuery(''); }}
          >
            Clear
          </button>
        )}
        <span className="muted">
          {filtering
            ? `${filtered.length} of ${rows.length}`
            : `${rows.length} submitted`}
        </span>
      </div>

      {filtered.length === 0 ? (
        <p className="muted">Nothing matches that.</p>
      ) : (
        <>
          <ul className="evidence-review">
            {shown.map((r) => {
              const { row, col } = fromPosition(r.tile_position);
              return (
                <li key={r.id}>
                  <a href={urls[r.storage_path]} target="_blank" rel="noreferrer">
                    {urls[r.storage_path]
                      ? <img
                          src={urls[r.storage_path]}
                          alt={`Submitted by ${r.uploaded_by_name} for ${r.tile_name}`}
                          loading="lazy"
                        />
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

          {pageCount > 1 && (
            <div className="evidence-pager">
              <button
                className="ghost"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                ← Newer
              </button>
              <span className="muted">Page {page + 1} of {pageCount}</span>
              <button
                className="ghost"
                disabled={page >= pageCount - 1}
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              >
                Older →
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
