import { Fragment } from 'react';
import { GRID, colLetter } from '../lib/board.js';

/**
 * The enemy board: 100 numbered tiles. A tile shows only its number until this
 * team claims it — the task itself stays hidden server-side (see `tiles_for_me`).
 * Fired tiles show the hit/miss they produced.
 */
export default function EnemyGrid({ tiles, onClaim, canClaim, busyTileId }) {
  const byPosition = new Map(tiles.map((t) => [t.position, t]));

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
              const position = r * GRID + c + 1;
              const tile = byPosition.get(position);
              if (!tile) return <div key={position} className="cell empty" />;

              const fired = tile.claim_status === 'fired';
              const active = tile.claim_status === 'active';
              const cls = [
                'cell',
                fired ? (tile.claim_result === 'hit' ? 'hit' : 'miss') : '',
                active ? 'active' : '',
                !tile.revealed && canClaim ? 'claimable' : '',
              ].filter(Boolean).join(' ');

              return (
                <button
                  key={position}
                  className={cls}
                  disabled={tile.revealed || !canClaim || busyTileId === tile.id}
                  title={tile.revealed ? tile.name : `Tile ${position} — not yet claimed`}
                  onClick={() => onClaim(tile)}
                >
                  {fired ? (tile.claim_result === 'hit' ? '✕' : '·') : position}
                </button>
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
