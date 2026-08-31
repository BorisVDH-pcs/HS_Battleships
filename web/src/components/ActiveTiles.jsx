import { useState } from 'react';
import { fireTile } from '../lib/supabase.js';
import { fromPosition, coordLabel } from '../lib/board.js';
import TileIcon from './TileIcon.jsx';

/**
 * The two slots. Replaces the spreadsheet's L6 / N6 cells: a team may hold at
 * most `max_active_tiles` claimed-but-unfired tiles, enforced by a database
 * trigger rather than by checking whether two cells happen to be full.
 *
 * "Fire" means the team finished the tile's in-game task. The result comes back
 * synchronously — no waiting on a recalculation.
 *
 * Drawn as cards rather than rows: these two tiles are the team's whole to-do
 * list, so they get the tile's own artwork at a size you can read across a
 * room, and an empty slot holds the same shape so the row does not jump as
 * tiles are claimed and fired.
 */
export default function ActiveTiles({ tiles, maxActive, onFired, emptyHint }) {
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);

  const active = tiles.filter((t) => t.claim_status === 'active');
  const slots = Array.from({ length: maxActive }, (_, i) => active[i] ?? null);

  async function fire(tile) {
    if (!confirm(`Complete "${tile.name}"? This fires the shot.`)) return;
    setBusyId(tile.claim_id);
    setError(null);
    try {
      const result = await fireTile(tile.claim_id);
      onFired?.(tile, result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="active-tiles">
      <h2>Active tiles ({active.length}/{maxActive})</h2>

      <div className="slots">
        {slots.map((tile, i) => {
          if (!tile) {
            return (
              <article key={`empty${i}`} className="slot empty">
                <div className="slot-art" aria-hidden="true" />
                <p>{emptyHint ?? 'Empty slot — claim a tile on the enemy board.'}</p>
              </article>
            );
          }

          const { row, col } = fromPosition(tile.position);
          const label = coordLabel(row, col);

          return (
            <article key={tile.id} className="slot filled">
              {/* A claimed tile always has its name; the icon is optional, so
                  the coordinate stands in as it does on the board itself. */}
              <div className="slot-art">
                <TileIcon
                  slug={tile.icon}
                  fallback={<span className="slot-art-coord">{label}</span>}
                />
              </div>

              <div className="slot-head">
                <strong>{tile.name}</strong>
                <span className="coord">{label}</span>
              </div>

              <button onClick={() => fire(tile)} disabled={busyId === tile.claim_id}>
                {busyId === tile.claim_id ? 'Firing…' : 'Mark complete & fire'}
              </button>
            </article>
          );
        })}
      </div>

      {error && <p className="error">{error}</p>}
    </section>
  );
}
