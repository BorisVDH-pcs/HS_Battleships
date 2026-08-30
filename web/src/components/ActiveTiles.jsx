import { useState } from 'react';
import { fireTile } from '../lib/supabase.js';
import { fromPosition, coordLabel } from '../lib/board.js';

/**
 * The two slots. Replaces the spreadsheet's L6 / N6 cells: a team may hold at
 * most `max_active_tiles` claimed-but-unfired tiles, enforced by a database
 * trigger rather than by checking whether two cells happen to be full.
 *
 * "Fire" means the team finished the tile's in-game task. The result comes back
 * synchronously — no waiting on a recalculation.
 */
export default function ActiveTiles({ tiles, maxActive, onFired }) {
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
      {slots.map((tile, i) =>
        tile ? (
          <article key={tile.id} className="slot filled">
            <header>
              <strong>{tile.name}</strong>
              <span className="coord">
                {coordLabel(fromPosition(tile.position).row, fromPosition(tile.position).col)}
              </span>
            </header>
            <button onClick={() => fire(tile)} disabled={busyId === tile.claim_id}>
              {busyId === tile.claim_id ? 'Firing…' : 'Mark complete & fire'}
            </button>
          </article>
        ) : (
          <article key={`empty${i}`} className="slot empty">
            <p>Empty slot — claim a tile on the enemy board.</p>
          </article>
        )
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
