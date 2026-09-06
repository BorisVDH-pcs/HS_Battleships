import { useState } from 'react';
import { GRID, coordLabel } from '../lib/board.js';

/**
 * The organiser's view of the tile content: all 100 squares with their real
 * names, laid out as the board.
 *
 * This is the counterpart to AdminOverview, which shows the fleets. Between them
 * an admin can see both secrets; neither is reachable without `is_admin()`,
 * because both are fed by `admin_list_*` definer functions. Players get
 * `tiles_for_me()` instead, which nulls `name` and `icon` until a tile is
 * locked in — so nothing here may ever be rendered on a player's page.
 *
 * One layout, not two. This used to offer a grid as well -- "what is at G7"
 * -- but the board builder draws that same grid on the way in, and goes on
 * drawing it once the game is running and the tiles are locked ("below is the
 * board that is running"). A second copy behind a button was one more place to
 * look for something already on the screen.
 *
 * The list is a different question and stays. "Did all 100 import correctly" is
 * a proofreading job: it wants one tile per line in board order, with the icon
 * slug and the point values spelled out -- none of which a square on a grid has
 * room for.
 */
export default function TileBoard({ tiles, canEdit = false, editOpen = false, onToggleEdit }) {
  const [listOpen, setListOpen] = useState(false);

  const byPosition = new Map(tiles.map((t) => [t.position, t]));
  const missing = [];
  for (let p = 1; p <= GRID * GRID; p += 1) {
    if (!byPosition.has(p)) missing.push(p);
  }

  return (
    <>
      <div className="tile-actions">
        <button className="ghost" onClick={() => setListOpen(!listOpen)}>
          {listOpen ? 'Hide list' : 'Show as list'}
        </button>
        {canEdit && (
          <button className="ghost" onClick={onToggleEdit}>
            {editOpen ? 'Cancel' : 'Replace tiles'}
          </button>
        )}
      </div>

      {listOpen && (
        <p className="muted" style={{ marginTop: '.6rem' }}>
          Admin only — these names are hidden from players until they lock a square in.
        </p>
      )}

      {listOpen && missing.length > 0 && (
        <p className="error" style={{ marginTop: '.6rem' }}>
          {missing.length} square(s) have no tile:{' '}
          {missing.slice(0, 12).map((p) => coordLabel(
            Math.floor((p - 1) / GRID) + 1, ((p - 1) % GRID) + 1
          )).join(', ')}
          {missing.length > 12 ? '…' : ''}
        </p>
      )}

      {listOpen && (
        <ol className="tile-list">
          {Array.from({ length: GRID * GRID }, (_, i) => {
            const p = i + 1;
            const t = byPosition.get(p);
            const rule = t?.completion ?? 'points';
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
                    {/* A priced tile (0046) reads as a target in points, with
                        what each drop is worth spelled out — checking a hundred
                        pasted lines is the whole reason this view exists, and a
                        bare "x6" would not show whether the prices landed. */}
                    {rule === 'value' ? (
                      <em className="tile-amount">{t.required_evidence}m total</em>
                    ) : rule === 'one_set' || rule === 'each_set' ? (
                      <>
                        <em className="tile-amount">
                          {rule === 'one_set'
                            ? 'any full set'
                            : `${t.per_set ?? 1} different from each`}
                        </em>
                        <em className="tile-options">
                          {t.options?.map((o) => o.grp ? `${o.grp}/${o.label}` : o.label).join(' · ')}
                        </em>
                      </>
                    ) : t.options?.length > 0 ? (
                      <>
                        <em className="tile-amount">{t.required_evidence} pts</em>
                        <em className="tile-options">
                          {t.options.map((o) => `${o.label} ${o.points}`).join(' · ')}
                        </em>
                      </>
                    ) : (
                      /* Only when it is not the default. A column of "x1" would
                         bury the handful of tiles that actually ask for more. */
                      t.required_evidence > 1 && (
                        <em className="tile-amount">&times;{t.required_evidence}</em>
                      )
                    )}
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
