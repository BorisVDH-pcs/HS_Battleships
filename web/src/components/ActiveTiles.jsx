import { useState } from 'react';
import { fireTile } from '../lib/supabase.js';
import { fromPosition, coordLabel } from '../lib/board.js';
import TileIcon from './TileIcon.jsx';
import EvidenceUploader from './EvidenceUploader.jsx';

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
export default function ActiveTiles({
  tiles, maxActive, onFired, onRefresh, emptyHint, gameId, teamId, evidence = [],
}) {
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);

  const active = tiles.filter((t) => t.claim_status === 'active');

  // Grouped once rather than filtered per card.
  const byClaim = new Map();
  for (const e of evidence) {
    if (!byClaim.has(e.claim_id)) byClaim.set(e.claim_id, []);
    byClaim.get(e.claim_id).push(e);
  }
  const slots = Array.from({ length: maxActive }, (_, i) => active[i] ?? null);

  // `asked` is false when the evidence uploader has already confirmed: the
  // last submit and the shot are one action, so it must not ask twice.
  async function fire(tile, asked = true) {
    if (asked && !confirm(`Complete "${tile.name}"? This fires the shot.`)) return;
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
          const mine = byClaim.get(tile.claim_id) ?? [];
          // required_evidence is redacted for unclaimed tiles, but a tile in a
          // slot is claimed by definition, so the fallback is belt and braces.
          const required = tile.required_evidence ?? 1;
          const ready = mine.length >= required;

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

              <EvidenceUploader
                claimId={tile.claim_id}
                gameId={gameId}
                teamId={teamId}
                tileName={tile.name}
                required={required}
                evidence={mine}
                onUploaded={async ({ completed, fired, result }) => {
                  // The submit that meets the requirement IS the shot, and
                  // add_evidence fires it in the same transaction — so by the
                  // time this runs the result is already known.
                  if (fired) { onFired?.(tile, result); return; }
                  // A server that has not been migrated yet returns no result;
                  // fire the old way rather than strand the tile.
                  if (completed) await fire(tile, false);
                  else onRefresh?.();
                }}
              />

              {/* Rescue only. Since 0023 the shot goes off inside the same
                  transaction as the last piece of evidence, so a tile cannot
                  reach full evidence and stay active — this card is gone before
                  the button renders. It stays for rows that predate that, and
                  for anything an organiser edits into the database by hand. */}
              {ready && (
                <button
                  onClick={() => fire(tile)}
                  disabled={busyId === tile.claim_id}
                >
                  {busyId === tile.claim_id ? 'Firing…' : 'Complete & fire'}
                </button>
              )}
            </article>
          );
        })}
      </div>

      {error && <p className="error">{error}</p>}
    </section>
  );
}
