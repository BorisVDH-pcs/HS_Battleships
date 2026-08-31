import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase.js';
import { signedUrls } from '../lib/evidence.js';
import { GRID, colLetter, coordLabel, fromPosition } from '../lib/board.js';

/**
 * Both task boards, as each team has worked them.
 *
 * AdminBoards shows the two FLEET boards — hulls and incoming shots. This is
 * the other half: the shared 100-tile grid, once per team, showing what each
 * has claimed, part-done and fired. Click any claimed square to read its
 * evidence.
 *
 * The partial state is the point. A claim sitting at 1 of 3 screenshots is a
 * team mid-task, and until tiles could need more than one completion there was
 * no such thing to show.
 *
 * Everything here pairs a tile's name with a team, which is what a player must
 * never see. admin_tile_progress() and admin_list_evidence() both refuse anyone
 * who is not an admin, so the gate is the database, not this component.
 */
export default function AdminTileBoards({ gameId }) {
  const [rows, setRows] = useState([]);
  const [evidence, setEvidence] = useState([]);
  const [urls, setUrls] = useState({});
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!gameId) { setRows([]); setEvidence([]); return; }
    setLoading(true);
    try {
      const [{ data: progress, error: pErr }, { data: ev, error: eErr }] = await Promise.all([
        supabase.rpc('admin_tile_progress', { p_game_id: gameId }),
        supabase.rpc('admin_list_evidence', { p_game_id: gameId }),
      ]);
      if (pErr) throw new Error(pErr.message);
      if (eErr) throw new Error(eErr.message);
      setRows(progress ?? []);
      setEvidence(ev ?? []);
      setUrls(await signedUrls((ev ?? []).map((e) => e.storage_path)));
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [gameId]);

  useEffect(() => { load(); }, [load]);

  // An upload writes no game_event, so Realtime never fires for one. Rather
  // than invent an event for the feed — which is world-readable and must not
  // learn anything new about tiles — this reloads on demand.
  useEffect(() => {
    if (!gameId) return;
    const id = setInterval(load, 20000);
    return () => clearInterval(id);
  }, [gameId, load]);

  if (error) return <p className="error">{error}</p>;
  if (!gameId || !rows.length) {
    return <p className="muted">{loading ? 'Loading boards…' : 'No tiles in this game yet.'}</p>;
  }

  const teams = [];
  for (const r of rows) {
    if (!teams.some((t) => t.id === r.team_id)) {
      teams.push({ id: r.team_id, name: r.team_name });
    }
  }

  const shown = selected ? evidence.filter((e) => e.claim_id === selected.claim_id) : [];

  return (
    <>
      <div className="columns">
        {teams.map((team) => {
          const mine = new Map(
            rows.filter((r) => r.team_id === team.id).map((r) => [r.position, r])
          );
          const claimed = [...mine.values()].filter((r) => r.claim_id);
          const partial = claimed.filter(
            (r) => r.status === 'active' && r.evidence_count > 0
              && r.evidence_count < r.required_evidence
          );

          return (
            <section key={team.id}>
              <h3>{team.name}</h3>
              <p className="muted">
                {claimed.length} claimed · {partial.length} part-done
              </p>
              <div className="board-grid">
                <div className="corner" />
                {Array.from({ length: GRID }, (_, i) => (
                  <div key={`h${i}`} className="axis">{colLetter(i + 1)}</div>
                ))}
                {Array.from({ length: GRID }, (_, r) => {
                  const row = r + 1;
                  return [
                    <div key={`a${row}`} className="axis">{row}</div>,
                    ...Array.from({ length: GRID }, (_, c) => {
                      const col = c + 1;
                      const position = r * GRID + col;
                      const cell = mine.get(position);
                      const label = coordLabel(row, col);

                      let cls = 'cell';
                      let body = <span className="coord-label">{label}</span>;

                      if (cell?.status === 'fired') {
                        cls += cell.result === 'hit' ? ' hit' : ' miss';
                        body = cell.result === 'hit' ? '✕' : '·';
                      } else if (cell?.claim_id) {
                        // Active: show the progress, which is the whole reason
                        // this board exists.
                        const met = cell.evidence_count >= cell.required_evidence;
                        cls += met ? ' active ready' : ' active';
                        body = (
                          <span className="tile-progress">
                            {cell.evidence_count}/{cell.required_evidence}
                          </span>
                        );
                      }

                      if (!cell?.claim_id) {
                        return <div key={position} className={cls} title={label}>{body}</div>;
                      }

                      const on = selected?.claim_id === cell.claim_id;
                      return (
                        <button
                          key={position}
                          className={`${cls} clickable${on ? ' picked' : ''}`}
                          title={`${label} — ${cell.tile_name}`}
                          onClick={() => setSelected(on ? null : cell)}
                        >
                          {body}
                        </button>
                      );
                    }),
                  ];
                })}
              </div>
            </section>
          );
        })}
      </div>

      {selected && (
        <div className="tile-evidence-panel">
          <div className="panel-head">
            <h3>
              {selected.tile_name}
              <span className="coord">
                {' '}{coordLabel(
                  fromPosition(selected.position).row,
                  fromPosition(selected.position).col
                )}
              </span>
            </h3>
            <button className="ghost" onClick={() => setSelected(null)}>Close</button>
          </div>
          <p className="muted">
            {selected.team_name} · {selected.evidence_count} of{' '}
            {selected.required_evidence} submitted
            {selected.status === 'fired'
              ? ` · fired, ${selected.result}`
              : ' · not yet fired'}
          </p>

          {shown.length === 0 ? (
            <p className="muted">Nothing submitted for this tile yet.</p>
          ) : (
            <ul className="evidence-review">
              {shown.map((e) => (
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
      )}
    </>
  );
}
