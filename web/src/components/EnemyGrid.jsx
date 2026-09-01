import { Fragment } from 'react';
import { GRID, colLetter, coordLabel } from '../lib/board.js';
import TileIcon from './TileIcon.jsx';

/**
 * The enemy board: 100 tiles labelled A1..J10. A tile shows only its coordinate
 * until this team locks it in — the task itself stays hidden server-side (see
 * `tiles_for_me`). Fired tiles show the hit/miss they produced.
 *
 * The coordinate rather than the 1..100 position, because that is what people
 * say out loud and type into Discord, and it matches the axes and the feed.
 *
 * A locked-in tile shows its icon instead of the coordinate. `tiles_for_me`
 * nulls the icon exactly as it nulls the name, so a tile nobody has locked in has no
 * filename to render and none to request.
 *
 * A square this team has locked in stays clickable afterwards: pressing it
 * opens the evidence they have submitted for it. That is the only way back to a
 * screenshot once a tile has been fired — the uploader is gone by then, and the
 * tile is just a mark on the board.
 */
export default function EnemyGrid({ tiles, onClaim, onInspect, canClaim, busyTileId, openTileId }) {
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
                // 'dealt' colours it as the shooter's news, not the fleet
                // owner's: this is the board the team is firing at.
                fired ? (tile.claim_result === 'hit' ? 'hit dealt' : 'miss') : '',
                active ? 'active' : '',
                !tile.revealed && canClaim ? 'claimable' : '',
                tile.revealed ? 'clickable' : '',
                openTileId === tile.id ? 'picked' : '',
              ].filter(Boolean).join(' ');

              return (
                <button
                  key={position}
                  className={cls}
                  disabled={
                    busyTileId === tile.id || (!tile.revealed && !canClaim)
                  }
                  title={tile.revealed
                    ? `${label} — ${tile.name} · see evidence`
                    : `${label} — not yet locked in`}
                  onClick={() => (tile.revealed ? onInspect?.(tile) : onClaim(tile))}
                >
                  {/* A fired square keeps its picture. The result is carried
                      by the coloured ground and the mark over the top, so the
                      board still reads as a board of tasks once most of it has
                      been shot at. */}
                  <TileIcon
                    slug={tile.icon}
                    standIn={tile.revealed}
                    fallback={<span className="coord-label">{label}</span>}
                  />
                  {fired && (
                    <span className="mark">
                      {tile.claim_result === 'hit' ? '✸' : '○'}
                    </span>
                  )}
                </button>
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
