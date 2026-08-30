import { useCallback, useEffect, useState } from 'react';
import { supabase, adminListTiles, adminListShipCells } from '../lib/supabase.js';
import { GRID, colLetter, coordLabel, cellKey } from '../lib/board.js';

/**
 * The organiser's view: both boards at once, with nothing hidden.
 *
 * A player sees two half-boards — the enemy's water with their own shots on it,
 * and their own fleet. An admin has no team, so instead each board here shows
 * ONE team's waters: that team's ships, plus the shots the opponent has taken
 * at them. That is the view that lets you answer "how is the game going" at a
 * glance, which is what running an event actually needs.
 *
 * This is deliberately the only place both fleets appear together, and it is
 * reachable only through the admin-gated RPCs.
 */
export default function AdminBoards({ gameId, teams }) {
  const [tiles, setTiles] = useState([]);
  const [shipCells, setShipCells] = useState([]);
  const [claims, setClaims] = useState([]);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!gameId) return;
    try {
      const [t, s, c] = await Promise.all([
        adminListTiles(gameId),
        adminListShipCells(gameId),
        supabase.from('tile_claims').select('tile_id, team_id, status, result'),
      ]);
      setTiles(t ?? []);
      setShipCells(s ?? []);
      setClaims(c.data ?? []);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [gameId]);

  useEffect(() => { load(); }, [load]);

  // Refresh on any event in this game, so the overview tracks a live match.
  useEffect(() => {
    if (!gameId) return;
    const ch = supabase
      .channel(`admin-boards-${gameId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'game_events', filter: `game_id=eq.${gameId}` },
        () => load())
      .subscribe((status) => {
        // A failed subscription is otherwise silent: the board simply stops
        // updating and looks like a quiet game.
        // CLOSED is expected once per mount under React StrictMode, which
        // subscribes, tears down and resubscribes. Only a lasting failure
        // matters, and it is otherwise silent — the board just stops updating.
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('[admin-boards] realtime not connected:', status);
        }
      });
    return () => { supabase.removeChannel(ch); };
  }, [gameId, load]);

  if (error) return <p className="error">{error}</p>;
  if (!gameId || teams.length === 0) return null;

  const tileById = new Map(tiles.map((t) => [t.id, t]));

  return (
    <>
      <div className="columns">
        {teams.map((team) => {
          // This team's own hulls.
          const ships = new Map();
          for (const c of shipCells) {
            if (c.team_id === team.id) ships.set(cellKey(c.row, c.col), c.ship_id);
          }

          // Shots the OTHER team has taken at this board.
          const incoming = new Map();
          for (const cl of claims) {
            if (cl.team_id === team.id) continue;   // their own shots land elsewhere
            const tile = tileById.get(cl.tile_id);
            if (tile) incoming.set(cellKey(tile.row, tile.col), cl);
          }

          const shipIds = new Set(ships.values());
          const sunk = [...shipIds].filter((id) => {
            const cells = shipCells.filter((c) => c.ship_id === id);
            return cells.every((c) => incoming.get(cellKey(c.row, c.col))?.result === 'hit');
          });
          const hits = [...ships.keys()].filter((k) => incoming.get(k)?.result === 'hit');

          return (
            <section key={team.id}>
              <h3>{team.name}</h3>
              <p className="muted">
                {shipIds.size === 0
                  ? 'No fleet placed yet.'
                  : `${sunk.length} of ${shipIds.size} ships sunk · ${hits.length} cells hit`}
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
                      const key = cellKey(row, col);
                      const isShip = ships.has(key);
                      const shot = incoming.get(key);

                      // A hit outranks everything: it is the fact that matters.
                      // A ship cell not yet fired at still shows as a ship, so
                      // the fleet stays readable underneath the shots.
                      let cls = 'cell';
                      if (shot?.status === 'fired' && shot.result === 'hit') cls += ' hit';
                      else if (shot?.status === 'fired') cls += ' miss';
                      else if (isShip) cls += ' ship';
                      if (shot?.status === 'active') cls += ' active';

                      // Same labelling as the player board: a bare cell names
                      // itself, so a square can be read off without counting
                      // along the axes. A shot marker outranks the label.
                      const label = coordLabel(row, col);
                      const mark =
                        shot?.status === 'fired' && shot.result === 'hit' ? '✕'
                          : shot?.status === 'active' ? '•'
                            : label;

                      return (
                        <div key={key} className={cls} title={label}>
                          {mark}
                        </div>
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
        <span className="key ship" /> ship afloat
        <span className="key hit" /> hit
        <span className="key miss" /> miss
        <span className="key active" /> claimed, not yet fired
      </p>
    </>
  );
}
