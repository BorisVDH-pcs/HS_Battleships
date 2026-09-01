import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase, adminListShipCells, adminReleaseClaim } from '../lib/supabase.js';
import EvidencePanel from './EvidencePanel.jsx';
import { useConfirm } from './ConfirmDialog.jsx';
import { GRID, colLetter, coordLabel, cellKey, fromPosition } from '../lib/board.js';

/**
 * One board per team, with everything on it.
 *
 * There used to be two of these cards — one for fleets, one for task progress —
 * which drew the same ten-by-ten grid four times over and left the organiser
 * matching coordinates between them by eye. It is all one coordinate space, so
 * it is one board.
 *
 * A board is labelled with the team that SHOOTS at it, which is the board that
 * team is playing against: the opponent's hulls are the targets, and this team's
 * locked-in tiles and shots are the marks on it. So Team Alpha's board carries Bravo's
 * ships and Alpha's hits — read it and you are reading Alpha's game.
 *
 * Locked-in squares are buttons. Clicking one opens the evidence submitted for it.
 *
 * Every row here pairs a tile's name, or an enemy hull, with a team — precisely
 * what a player must never see. admin_tile_progress(), admin_list_ship_cells()
 * and admin_list_evidence() each refuse anyone who is not an admin, so the gate
 * is the database, not this component.
 */
export default function AdminOverview({ gameId, teams }) {
  const [rows, setRows] = useState([]);
  const [shipCells, setShipCells] = useState([]);
  const [evidence, setEvidence] = useState([]);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const panelRef = useRef(null);

  const load = useCallback(async () => {
    if (!gameId) { setRows([]); setShipCells([]); setEvidence([]); return; }
    setLoading(true);
    try {
      const [{ data: progress, error: pErr }, ships, { data: ev, error: eErr }] =
        await Promise.all([
          supabase.rpc('admin_tile_progress', { p_game_id: gameId }),
          adminListShipCells(gameId),
          supabase.rpc('admin_list_evidence', { p_game_id: gameId }),
        ]);
      if (pErr) throw new Error(pErr.message);
      if (eErr) throw new Error(eErr.message);
      setRows(progress ?? []);
      setShipCells(ships ?? []);
      setEvidence(ev ?? []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [gameId]);

  useEffect(() => { load(); }, [load]);

  // Shots and placements announce themselves on the feed, so the board tracks a
  // live match.
  useEffect(() => {
    if (!gameId) return;
    const ch = supabase
      .channel(`admin-overview-${gameId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'game_events', filter: `game_id=eq.${gameId}` },
        () => load())
      .subscribe((status) => {
        // CLOSED is expected once per mount under StrictMode. A lasting failure
        // is otherwise silent — the board just stops updating.
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('[admin-overview] realtime not connected:', status);
        }
      });
    return () => { supabase.removeChannel(ch); };
  }, [gameId, load]);

  // An upload writes no game_event — the feed is world-readable and must not
  // learn anything new about tiles — so evidence counts need a poll of their own.
  useEffect(() => {
    if (!gameId) return;
    const id = setInterval(load, 20000);
    return () => clearInterval(id);
  }, [gameId, load]);

  if (error) return <p className="error">{error}</p>;
  if (!gameId || teams.length === 0) return null;
  if (!rows.length) {
    return <p className="muted">{loading ? 'Loading boards…' : 'No tiles in this game yet.'}</p>;
  }

  function pick(cell) {
    const same = selected?.claim_id === cell.claim_id;
    setSelected(same ? null : cell);
    if (!same) {
      // The panel sits under the boards; on a full page that is off-screen.
      requestAnimationFrame(() =>
        panelRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      );
    }
  }

  const shown = selected ? evidence.filter((e) => e.claim_id === selected.claim_id) : [];

  /**
   * Hand a slot back. Names the square, the team and — the part worth reading
   * twice — how many screenshots go with it, because the claim's evidence
   * cascades and the count is the thing an organiser will regret not seeing.
   */
  async function release(cell) {
    const at = coordLabel(fromPosition(cell.position).row, fromPosition(cell.position).col);
    const n = shown.length;
    if (!(await confirm(
      `${at} — "${cell.tile_name}" goes back on the board and ${cell.team_name} ` +
      'gets the slot back.\n' +
      (n > 0
        ? `Its ${n} submitted screenshot${n === 1 ? '' : 's'} will be deleted with it.\n`
        : 'Nothing has been submitted for it yet.\n') +
      '\nThis cannot be undone.',
      { title: `Release ${at}?`, confirmLabel: 'Release it', danger: true }
    ))) return;

    setReleasing(true);
    try {
      await adminReleaseClaim(cell.claim_id);
      setSelected(null);
      await load();
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setReleasing(false);
    }
  }

  return (
    <>
      <div className="columns">
        {teams.map((team) => {
          const enemy = teams.find((t) => t.id !== team.id);

          // This team's own locked-in tiles: what they have worked and fired.
          const mine = new Map(
            rows.filter((r) => r.team_id === team.id).map((r) => [r.position, r])
          );
          // The hulls they are shooting at belong to the other team.
          const hulls = new Map();
          for (const c of shipCells) {
            if (enemy && c.team_id === enemy.id) hulls.set(cellKey(c.row, c.col), c.ship_id);
          }

          const claimed = [...mine.values()].filter((r) => r.claim_id);
          const partial = claimed.filter(
            (r) => r.status === 'active' && r.evidence_count > 0
              && r.evidence_count < r.required_evidence
          );
          const hitAt = (key) => {
            const { row, col } = keyToRowCol(key);
            const c = mine.get((row - 1) * GRID + col);
            return c?.status === 'fired' && c.result === 'hit';
          };
          const shipIds = new Set(hulls.values());
          const sunk = [...shipIds].filter((id) =>
            shipCells.filter((c) => c.ship_id === id)
              .every((c) => hitAt(cellKey(c.row, c.col)))
          );
          const hits = [...hulls.keys()].filter(hitAt);

          return (
            <section key={team.id}>
              <h3>{team.name}</h3>
              <p className="muted">
                {enemy ? `Shooting at ${enemy.name}’s fleet. ` : ''}
                {shipIds.size === 0
                  ? 'No fleet to shoot at yet.'
                  : `${sunk.length} of ${shipIds.size} sunk · ${hits.length} hits`}
                {' · '}{claimed.length} locked in · {partial.length} part-done
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
                      const position = (row - 1) * GRID + col;
                      const cell = mine.get(position);
                      const isShip = hulls.has(cellKey(row, col));
                      const label = coordLabel(row, col);

                      let cls = 'cell';
                      let body = <span className="coord-label">{label}</span>;

                      if (cell?.status === 'fired') {
                        // Each board is labelled with the team doing the
                        // shooting, so a hit is always their good news.
                        cls += cell.result === 'hit' ? ' hit dealt' : ' miss';
                        body = cell.result === 'hit'
                          ? <span className="mark">✸</span>
                          : <span className="mark">○</span>;
                      } else {
                        // An unfired hull stays visible under a locked-in tile, so
                        // the enemy fleet reads as a fleet however much is taken.
                        if (isShip) cls += ' ship';
                        if (cell?.claim_id) {
                          const met = cell.evidence_count >= cell.required_evidence;
                          cls += met ? ' active ready' : ' active';
                          body = (
                            <span className="tile-progress">
                              {cell.evidence_count}/{cell.required_evidence}
                            </span>
                          );
                        }
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
                          onClick={() => pick(cell)}
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

      <p className="legend">
        <span className="key ship" /> enemy ship afloat
        <span className="key hit dealt" /> hit
        <span className="key miss" /> miss
        <span className="key active" /> locked in, not yet fired
      </p>

      {selected && (
        <div ref={panelRef}>
          <EvidencePanel
            title={selected.tile_name}
            coord={coordLabel(
              fromPosition(selected.position).row,
              fromPosition(selected.position).col
            )}
            meta={
              `${selected.team_name} · ${selected.evidence_count} of ` +
              `${selected.required_evidence} submitted` +
              (selected.status === 'fired'
                ? ` · fired, ${selected.result}`
                : ' · not yet fired')
            }
            items={shown}
            onClose={() => setSelected(null)}
          />

          {/* Only for a tile still being worked. A fired one is a shot that has
              already counted, and the RPC refuses it too. Sits under the
              evidence rather than on the square itself, so the organiser has
              looked at what they are about to destroy before they can press
              it. */}
          {selected.status === 'active' && (
            <p className="row" style={{ marginTop: '.6rem' }}>
              <button
                className="danger"
                disabled={releasing}
                onClick={() => release(selected)}
              >
                {releasing ? 'Releasing…' : 'Release this tile'}
              </button>
              <span className="muted">
                Gives {selected.team_name} the slot back. The square can be
                locked in again — by either team.
              </span>
            </p>
          )}
        </div>
      )}
      {confirmDialog}
    </>
  );
}

/** cellKey is 'row:col'; this reads it back. */
function keyToRowCol(key) {
  const [row, col] = key.split(':').map(Number);
  return { row, col };
}
