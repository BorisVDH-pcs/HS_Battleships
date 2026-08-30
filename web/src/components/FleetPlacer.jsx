import { useMemo, useState } from 'react';
import { placeFleet } from '../lib/supabase.js';
import {
  GRID, colLetter, cellKey, shipFootprint, placementError, blockedCells,
} from '../lib/board.js';

const SHIP_NAMES = { 2: 'Cutter', 3: 'Frigate', 4: 'Galleon', 5: 'Man o’ War' };

/**
 * Click a ship, then click where its first cell goes. R rotates.
 *
 * The no-touching rule is checked here so a bad placement is refused before it
 * is submitted, but place_fleet() re-checks the whole fleet server-side — this
 * is for feedback, not enforcement.
 */
export default function FleetPlacer({ teamId, teamName, fleet, onPlaced }) {
  const [placed, setPlaced] = useState([]);   // [{ size, cells }]
  const [dir, setDir] = useState('h');
  const [selected, setSelected] = useState(null);   // index into remaining
  const [hover, setHover] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Which hulls are still in the yard, as [{ size, key }] so duplicates (3,3)
  // stay distinguishable.
  const remaining = useMemo(() => {
    const left = [...fleet];
    for (const p of placed) {
      const i = left.indexOf(p.size);
      if (i !== -1) left.splice(i, 1);
    }
    return left;
  }, [fleet, placed]);

  const placedCells = useMemo(() => placed.flatMap((p) => p.cells), [placed]);
  const occupied = useMemo(() => {
    const m = new Map();
    placed.forEach((p, i) => p.cells.forEach((c) => m.set(cellKey(c.row, c.col), i)));
    return m;
  }, [placed]);
  const noGo = useMemo(() => blockedCells(placedCells), [placedCells]);

  const activeSize = selected === null ? null : remaining[selected];

  const preview = useMemo(() => {
    if (!hover || activeSize == null) return null;
    const cells = shipFootprint(hover.row, hover.col, activeSize, dir);
    return { cells, error: placementError(cells, placedCells) };
  }, [hover, activeSize, dir, placedCells]);

  const previewKeys = useMemo(
    () => new Set(preview ? preview.cells.map((c) => cellKey(c.row, c.col)) : []),
    [preview]
  );

  function onCellClick(row, col) {
    // Clicking a placed ship picks it back up.
    const hit = occupied.get(cellKey(row, col));
    if (hit !== undefined) {
      setPlaced(placed.filter((_, i) => i !== hit));
      setError(null);
      return;
    }
    if (activeSize == null) { setError('Pick a ship from the yard first.'); return; }

    const cells = shipFootprint(row, col, activeSize, dir);
    const why = placementError(cells, placedCells);
    if (why) { setError(why); return; }

    setPlaced([...placed, { size: activeSize, cells }]);
    setSelected(null);
    setError(null);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await placeFleet(teamId, placed.map((p) => ({ size: p.size, cells: p.cells })));
      onPlaced?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="placer"
      onKeyDown={(e) => {
        if (e.key === 'r' || e.key === 'R') setDir((d) => (d === 'h' ? 'v' : 'h'));
      }}
      tabIndex={0}
    >
      <div>
        <h3>{teamName}</h3>
        <p className="muted">
          Pick a hull, then click its top-left cell. Press <strong>R</strong> to rotate
          ({dir === 'h' ? 'horizontal' : 'vertical'}). Click a placed ship to lift it.
          Ships may not touch, not even at the corners.
        </p>
      </div>

      <div className="yard">
        {remaining.map((size, i) => (
          <button
            key={`${size}-${i}`}
            className={selected === i ? '' : 'ghost'}
            onClick={() => { setSelected(selected === i ? null : i); setError(null); }}
          >
            {SHIP_NAMES[size] ?? `Ship`} · {size}
          </button>
        ))}
        {remaining.length === 0 && <span className="muted">All hulls placed.</span>}
        <button className="ghost" onClick={() => setDir(dir === 'h' ? 'v' : 'h')}>
          Rotate ({dir === 'h' ? 'H' : 'V'})
        </button>
      </div>

      <div className="board-grid" onMouseLeave={() => setHover(null)}>
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
              const isShip = occupied.has(key);
              const isPreview = previewKeys.has(key);
              const cls = [
                'cell',
                isShip ? 'ship' : '',
                isPreview ? (preview.error ? 'preview-bad' : 'preview') : '',
                !isShip && !isPreview && noGo.has(key) ? 'no-go' : '',
              ].filter(Boolean).join(' ');
              return (
                <button
                  key={key}
                  className={cls}
                  onMouseEnter={() => setHover({ row, col })}
                  onClick={() => onCellClick(row, col)}
                />
              );
            }),
          ];
        })}
      </div>

      {preview?.error && <p className="muted">{preview.error}</p>}
      {error && <p className="error">{error}</p>}

      <div className="row">
        <button onClick={submit} disabled={busy || remaining.length > 0}>
          {busy ? 'Saving…' : `Save fleet for ${teamName}`}
        </button>
        <button className="ghost" onClick={() => { setPlaced([]); setSelected(null); setError(null); }}>
          Clear
        </button>
        {remaining.length > 0 && (
          <span className="muted">{remaining.length} hull(s) still to place.</span>
        )}
      </div>
    </div>
  );
}
