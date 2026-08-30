import { Fragment } from 'react';
import { GRID, colLetter, coordLabel, cellKey, fromPosition } from '../lib/board.js';

/**
 * Your own board: where your ships sit, and where the enemy has shot.
 * `myShipCells` comes straight from the database — RLS guarantees the opponent
 * cannot run this same query against your team.
 */
export default function MyFleet({ myShipCells, enemyShots, tiles, fleet }) {
  const ships = new Set(myShipCells.map((c) => cellKey(c.row, c.col)));

  // Enemy shots reference tile ids; resolve them to coordinates via the tile list.
  const tilePos = new Map(tiles.map((t) => [t.id, t.position]));
  const shots = new Map();
  for (const shot of enemyShots) {
    const position = tilePos.get(shot.tile_id);
    if (!position) continue;
    const { row, col } = fromPosition(position);
    shots.set(cellKey(row, col), shot.result);
  }

  const sunk = fleet.filter((s) => s.sunk).length;

  return (
    <div className="board">
      <p className="fleet-status">
        Fleet: {fleet.length - sunk} afloat, {sunk} sunk
      </p>
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

              const cls = [
                'cell',
                isShip ? 'ship' : '',
                shot === 'hit' ? 'hit' : '',
                shot === 'miss' ? 'miss' : '',
              ].filter(Boolean).join(' ');

              return (
                // Labelled like the enemy board, so the two grids sitting
                // side by side read the same way.
                <div key={key} className={cls} title={coordLabel(row, col)}>
                  {shot === 'hit' ? '✕' : shot === 'miss' ? '·' : coordLabel(row, col)}
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
