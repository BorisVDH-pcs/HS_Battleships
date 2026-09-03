import { useEffect, useRef, useState } from 'react';
import { fireTile, completeTileEarly } from '../lib/supabase.js';
import { fromPosition, coordLabel } from '../lib/board.js';
import TileIcon from './TileIcon.jsx';
import EvidenceUploader from './EvidenceUploader.jsx';
import { useConfirm } from './ConfirmDialog.jsx';

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
  tiles, maxActive, onFired, onRefresh, emptyHint, gameId, teamId, evidence = [],
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

  // The short route. The count on these tiles is the worst case, so a team that
  // got there sooner says so rather than farming to a number it no longer needs.
  async function completeEarly(tile, have) {
    if (!(await confirm(
      `"${tile.name}" asks for ${tile.required_evidence}, and you have submitted ` +
      `${have}. Say it is done only if you have actually finished it by one of ` +
      'the shorter routes — the organiser reviews these, and it fires the shot now.',
      { title: 'Complete early?', confirmLabel: 'Complete Early' }
    ))) return;
    setBusyId(tile.claim_id);
    setError(null);
    try {
      const res = await completeTileEarly(tile.claim_id);
      onFired?.(tile, res?.result ?? null);
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
          const mine = byClaim.get(tile.claim_id) ?? [];
          // required_evidence is redacted for tiles nobody has locked in, but one in
          // a slot is locked in by definition, so the fallback is belt and braces.
          const required = tile.required_evidence ?? 1;
          const ready = mine.length >= required;

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
                <span className="coord">{label}</span>
              </div>

              <EvidenceUploader
                ref={(inst) => {
                  if (inst) uploaderRefs.current.set(tile.claim_id, inst);
                  else uploaderRefs.current.delete(tile.claim_id);
                }}
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

              {/* Tiles with more than one route to done (0025). Hidden until
                  there is something to review, because complete_tile_early
                  refuses with no evidence at all — a button that only ever
                  errors is worse than no button. Hidden once `ready`, since by
                  then the ordinary submit fires it and "early" is meaningless. */}
              {tile.early_complete && !ready && mine.length > 0 && (
                <button
                  className="ghost"
                  onClick={() => completeEarly(tile, mine.length)}
                  disabled={busyId === tile.claim_id}
                >
                  {busyId === tile.claim_id ? 'Firing…' : 'Complete Early'}
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
