import { Fragment } from 'react';
import { GRID, colLetter, coordLabel, cellKey, fromPosition, sunkShipIds } from '../lib/board.js';

/**
 * Your own board: where your ships sit, and where the enemy has shot.
 * `myShipCells` comes straight from the database — RLS guarantees the opponent
 * cannot run this same query against your team.
 */
export default function MyFleet({ myShipCells, enemyShots, tiles }) {
  const ships = new Set(myShipCells.map((c) => cellKey(c.row, c.col)));

  // Which ship occupies each cell, so a hit can be traced back to whether
  // that ship — not just that square — has gone down.
  const shipAt = new Map(myShipCells.map((c) => [cellKey(c.row, c.col), c.ship_id]));
  // Derived here rather than read off ship_status.sunk, which is always false
  // for a player - see sunkShipIds for why.
  const sunkShips = sunkShipIds(myShipCells, enemyShots, tiles);

  // Enemy shots reference tile ids; resolve them to coordinates via the tile list.
  const tilePos = new Map(tiles.map((t) => [t.id, t.position]));
  const shots = new Map();
  for (const shot of enemyShots) {
    const position = tilePos.get(shot.tile_id);
    if (!position) continue;
    const { row, col } = fromPosition(position);
    shots.set(cellKey(row, col), shot.result);
  }

  return (
    <div className="board">
      <div className="board-grid">
        <div className="corner" />
        {Array.from({ length: GRID }, (_, i) => (
          <div key={`h${i}`} className="axis">{colLetter(i + 1)}</div>
        ))}

        {Array.from({ length: GRID }, (_, r) => (
          <Fragment key={`row${r}`}>
            <div className="axis">{r + 1}</div>
            {Array.from({ length: GRID }, (_, c) => {
              const row = r + 1;
              const col = c + 1;
              const key = cellKey(row, col);
              const isShip = ships.has(key);
              const shot = shots.get(key);
              const sunk = shot === 'hit' && sunkShips.has(shipAt.get(key));

              const cls = [
                'cell',
                isShip ? 'ship' : '',
                // No 'dealt' here: on your own fleet a hit is damage, and
                // red is the one place it should mean exactly that.
                shot === 'hit' ? 'hit' : '',
                shot === 'miss' ? 'miss' : '',
                // A deader red once the whole ship is down, not just the square.
                sunk ? 'sunk' : '',
              ].filter(Boolean).join(' ');

              return (
                // Labelled like the enemy board, so the two grids sitting
                // side by side read the same way.
                <div key={key} className={cls} title={coordLabel(row, col)}>
                  {shot === 'hit' ? <span className="mark">{sunk ? '☠' : '✸'}</span>
                    : shot === 'miss' ? <span className="mark">○</span>
                    : <span className="coord-label">{coordLabel(row, col)}</span>}
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
