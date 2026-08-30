import { useState } from 'react';
import { GRID, colLetter, coordLabel } from '../lib/board.js';
import TileIcon from './TileIcon.jsx';

/**
 * The organiser's view of the tile content: all 100 squares with their real
 * names, laid out as the board.
 *
 * This is the counterpart to AdminBoards, which shows the fleets. Between them
 * an admin can see both secrets; neither is reachable without `is_admin()`,
 * because both are fed by `admin_list_*` definer functions. Players get
 * `tiles_for_me()` instead, which nulls `name` and `icon` until a tile is
 * claimed — so nothing here may ever be rendered on a player's page.
 *
 * Two layouts, because they answer different questions. The grid answers
 * "what is at G7"; the list answers "did all 100 import correctly", which is
 * a proofreading job and wants one tile per line in board order.
 */
export default function TileBoard({ tiles }) {
  const [view, setView] = useState(null);   // null | 'grid' | 'list'

  const byPosition = new Map(tiles.map((t) => [t.position, t]));
  const missing = [];
  for (let p = 1; p <= GRID * GRID; p += 1) {
    if (!byPosition.has(p)) missing.push(p);
  }

  const full = (t) => (t.icon ? `${t.name}  [${t.icon}]` : t.name);

  return (
    <>
      <div className="row" style={{ marginTop: '.6rem' }}>
        <button
          className="ghost"
          onClick={() => setView(view === 'grid' ? null : 'grid')}
        >
          {view === 'grid' ? 'Hide board' : 'Show board'}
        </button>
        <button
          className="ghost"
          onClick={() => setView(view === 'list' ? null : 'list')}
        >
          {view === 'list' ? 'Hide list' : 'Show as list'}
        </button>
        {view && (
          <span className="muted">
            Admin only — these names are hidden from players until claimed.
          </span>
        )}
      </div>

      {view && missing.length > 0 && (
        <p className="error" style={{ marginTop: '.6rem' }}>
          {missing.length} square(s) have no tile:{' '}
          {missing.slice(0, 12).map((p) => coordLabel(
            Math.floor((p - 1) / GRID) + 1, ((p - 1) % GRID) + 1
          )).join(', ')}
          {missing.length > 12 ? '…' : ''}
        </p>
      )}

      {view === 'grid' && (
        <div className="tile-board-wrap">
          <div className="tile-board">
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
                  const t = byPosition.get((row - 1) * GRID + col);
                  if (!t) {
                    return (
                      <div key={`${row}-${col}`} className="tile-cell empty">
                        {coordLabel(row, col)}
                      </div>
                    );
                  }
                  return (
                    // title carries the untruncated text: a 55-character tile
                    // name does not fit in a tenth of the page.
                    <div key={t.id} className="tile-cell" title={full(t)}>
                      <b>{coordLabel(row, col)}</b>
                      {t.icon && <TileIcon slug={t.icon} fallback={null} />}
                      <span>{t.name}</span>
                    </div>
                  );
                }),
              ];
            })}
          </div>
        </div>
      )}

      {view === 'list' && (
        <ol className="tile-list">
          {Array.from({ length: GRID * GRID }, (_, i) => {
            const p = i + 1;
            const t = byPosition.get(p);
            const label = coordLabel(
              Math.floor((p - 1) / GRID) + 1, ((p - 1) % GRID) + 1
            );
            return (
              <li key={p}>
                <b>{label}</b>
                {t ? (
                  <>
                    <span>{t.name}</span>
                    {/* The slug, not the picture: this view exists to check
                        that every tile got the icon it was meant to get. */}
                    <em>{t.icon || 'no icon'}</em>
                  </>
                ) : (
                  <span className="muted">— empty —</span>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}
