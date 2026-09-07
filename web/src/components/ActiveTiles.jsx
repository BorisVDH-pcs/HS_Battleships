import { useEffect, useRef, useState } from 'react';
import { fireTile } from '../lib/supabase.js';
import { fromPosition, coordLabel } from '../lib/board.js';
import { tileProgress } from '../lib/tileProgress.js';
import TileIcon from './TileIcon.jsx';
import TileInfo from './TileInfo.jsx';
import EvidenceUploader from './EvidenceUploader.jsx';
import { useConfirm } from './ConfirmDialog.jsx';

/**
 * How long ago, in the coarsest unit still true.
 *
 * Coarse on purpose. The question this answers is "has somebody been sitting
 * on this slot", and the difference between 41 and 43 minutes is not part of
 * it — a number that precise invites reading it as a deadline. Anything under
 * a minute is "just now" rather than a count of seconds, which also absorbs
 * the clock skew between a phone and the database without ever printing a
 * negative age.
 */
function sinceText(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The two slots. Replaces the spreadsheet's L6 / N6 cells: a team may hold at
 * most `max_active_tiles` locked-in-but-unfired tiles, enforced by a database
 * trigger rather than by checking whether two cells happen to be full.
 *
 * "Fire" means the team finished the tile's in-game task. The result comes back
 * synchronously — no waiting on a recalculation.
 *
 * Drawn as cards rather than rows: these two tiles are the team's whole to-do
 * list, so they get the tile's own artwork at a size you can read across a
 * room, and an empty slot holds the same shape so the row does not jump as
 * tiles are locked in and fired.
 *
 * Which tile a paste lands on is a click anywhere on its card, not just its
 * evidence zone — the whole card is the target, and `selected` shows which
 * one it is, since a plain focus ring on the small inner box was easy to
 * miss with several cards on screen.
 */
export default function ActiveTiles({
  tiles, maxActive, onFired, onRefresh, emptyHint, gameId, teamId,
}) {
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [selectedClaimId, setSelectedClaimId] = useState(null);
  const uploaderRefs = useRef(new Map());
  const [confirm, confirmDialog] = useConfirm();

  useEffect(() => {
    function onPaste(e) {
      if (!selectedClaimId) return;
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length) return;
      const uploader = uploaderRefs.current.get(selectedClaimId);
      if (uploader) { e.preventDefault(); uploader.stageFiles(files); }
    }
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [selectedClaimId]);

  // Re-render once a minute, only so the "held for" line stays true. The board
  // refetches when something happens, and a slot sitting on a tile nobody is
  // finishing is precisely the case where nothing does — which is also the
  // case the line exists to make visible. Without this it would freeze at
  // "2 min ago" for an hour and quietly say the opposite of what it means.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60000);
    return () => clearInterval(id);
  }, []);

  const active = tiles.filter((t) => t.claim_status === 'active');

  const slots = Array.from({ length: maxActive }, (_, i) => active[i] ?? null);

  // `asked` is false when the evidence uploader has already confirmed: the
  // last submit and the shot are one action, so it must not ask twice.
  async function fire(tile, asked = true) {
    if (asked && !(await confirm(
      `Complete "${tile.name}"? This fires the shot.`,
      { title: 'Fire the shot?', confirmLabel: 'Complete & fire' }
    ))) return;
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
    <section className="active-tiles" id="active-tiles-section">
      <h2>Active tiles ({active.length}/{maxActive})</h2>

      <div className="slots">
        {slots.map((tile, i) => {
          if (!tile) {
            return (
              <article key={`empty${i}`} className="slot empty">
                <div className="slot-art" aria-hidden="true" />
                <p>{emptyHint ?? 'Empty slot — lock in a tile on the enemy board.'}</p>
              </article>
            );
          }

          const { row, col } = fromPosition(tile.position);
          const label = coordLabel(row, col);
          // Whichever of the four rules this tile uses (0049), one helper
          // answers "how far along, and is it done" — the same helper the
          // uploader uses, so the counter and the Submit button cannot
          // disagree about whether the next screenshot fires the shot.
          const progress = tileProgress(tile);
          const ready = progress.done;

          return (
            <article
              key={tile.id}
              className={`slot filled${selectedClaimId === tile.claim_id ? ' selected' : ''}`}
              onClick={() => setSelectedClaimId(tile.claim_id)}
            >
              {/* A locked-in tile always has its name; the artwork is optional,
                  so an undrawn tile borrows the stand-in, exactly as it does on
                  the board itself. */}
              <div className="slot-art">
                <TileIcon
                  slug={tile.icon}
                  standIn
                  fallback={<span className="slot-art-coord">{label}</span>}
                />
              </div>

              <div className="slot-head">
                <strong>{tile.name}</strong>
                {/* Renders nothing when the tile has neither small print nor
                    priced drops, so the badge marks the tiles that actually
                    have something to say rather than sitting on all of them. */}
                <TileInfo tile={tile} />
                <span className="coord">{label}</span>
              </div>

              {/* Who is on this, and since when.
                  Three slots and a team of ten is a coordination problem, and
                  without this the card could not say whether a slot had been
                  held for four minutes or four hours -- so the question went
                  to Discord instead, about a card that already knew.

                  Renders nothing at all when the server has not been migrated
                  yet (0907's tiles_for_me is what returns these two columns),
                  so this is safe to ship ahead of the database. */}
              {(tile.claimed_by_name || tile.claimed_at) && (
                <p className="slot-claimant">
                  {tile.claimed_by_name
                    ? <>Locked in by <strong>{tile.claimed_by_name}</strong></>
                    : 'Locked in'}
                  {tile.claimed_at && <> · {sinceText(tile.claimed_at)}</>}
                </p>
              )}

              <EvidenceUploader
                ref={(inst) => {
                  if (inst) uploaderRefs.current.set(tile.claim_id, inst);
                  else uploaderRefs.current.delete(tile.claim_id);
                }}
                claimId={tile.claim_id}
                gameId={gameId}
                teamId={teamId}
                tile={tile}
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
      {confirmDialog}
    </section>
  );
}
