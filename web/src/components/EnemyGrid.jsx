import { Fragment } from 'react';
import { GRID, colLetter, coordLabel } from '../lib/board.js';
import TileIcon from './TileIcon.jsx';

/**
 * The enemy board: 100 tiles labelled A1..J10. A tile shows only its coordinate
 * until this team claims it — the task itself stays hidden server-side (see
 * `tiles_for_me`). Fired tiles show the hit/miss they produced.
 *
 * The coordinate rather than the 1..100 position, because that is what people
 * say out loud and type into Discord, and it matches the axes and the feed.
 *
 * A claimed tile shows its icon instead of the coordinate. `tiles_for_me`
 * nulls the icon exactly as it nulls the name, so an unclaimed tile has no
 * filename to render and none to request.
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
              const label = coordLabel(r + 1, c + 1);
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
                  title={tile.revealed ? `${label} — ${tile.name}` : `${label} — not yet claimed`}
                  onClick={() => onClaim(tile)}
                >
                  {fired
                    ? (tile.claim_result === 'hit' ? '✕' : '·')
                    : <TileIcon slug={tile.icon} fallback={label} />}
                </button>
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
