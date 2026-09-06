import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { uploadEvidence } from '../lib/evidence.js';
import { useConfirm } from './ConfirmDialog.jsx';

/**
 * Attaching proof to an active tile.
 *
 * Three ways in, because people submit screenshots three ways: drag onto the
 * card, pick a file, or paste. Paste matters most — a fresh screenshot is on
 * the clipboard already, and asking someone to save it to disk first is asking
 * them not to bother. Which tile a Ctrl+V lands on is decided by which card
 * was clicked last — anywhere on the card, not just this zone — tracked by
 * ActiveTiles and shown with a highlight, since a plain focus ring on a small
 * inner box was easy to miss on a board with several active tiles. This
 * component exposes `stageFiles` via ref so the parent can hand it a pasted
 * clipboard image.
 *
 * Dropping a file STAGES it; a second press submits it. That is what makes a
 * remove button possible at all: submitted evidence is immutable by design
 * (tile_evidence has a select policy and nothing else), so the only safe place
 * to change your mind is before it is uploaded. It also means a misdropped
 * screenshot is not permanently attached to the wrong tile.
 *
 * The submit that meets the requirement also fires the shot — there is no
 * separate "mark complete" press, because by then there is nothing left to
 * say. That submit reads differently and asks first, since it is the
 * irreversible one.
 *
 * WEIGHTED TILES (0046). Some tiles list several drops worth different points
 * and ask for a total rather than a count. There, each staged screenshot picks
 * its own drop — one submit can carry a rare and a common together, and the
 * same drop may be picked as many times as a team actually got it. The picker
 * is per file rather than per submit for exactly that reason: a single
 * selection for the whole batch would quietly mis-score the mixed case, which
 * is the case weighted tiles exist for.
 *
 * The points shown here are for reading, never for scoring. add_evidence looks
 * up what an option is worth server-side; nothing this component computes is
 * trusted by the database.
 *
 * There are deliberately no thumbnails of submitted evidence here. They made
 * the card nearly twice as tall for something a player has already seen; the
 * organiser's review screen is where the images actually need looking at.
 */
const EvidenceUploader = forwardRef(function EvidenceUploader({
  claimId, gameId, teamId, required, evidence, onUploaded, tileName,
  options = [], points = 0,
}, ref) {
  const [staged, setStaged] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);
  const [confirm, confirmDialog] = useConfirm();

  const weighted = options.length > 0;
  const have = weighted ? points : evidence.length;
  const done = have >= required;

  function stage(files) {
    const images = [...files].filter((f) => f.type.startsWith('image/'));
    if (!images.length) {
      if (files.length) setError('That was not an image.');
      return;
    }
    setError(null);
    // A weighted tile starts each file unassigned rather than defaulting to the
    // first drop. A wrong default that scores is worse than a picker that waits.
    setStaged((s) => [...s, ...images.map((file) => ({ file, optionId: null }))]);
  }

  useImperativeHandle(ref, () => ({ stageFiles: stage }));

  const pointsOf = (id) => options.find((o) => o.id === id)?.points ?? 0;
  const allAssigned = !weighted || staged.every((s) => s.optionId);

  // Computed from what is staged, not from `evidence`, which does not update
  // until the refetch after upload.
  const stagedWorth = weighted
    ? staged.reduce((sum, s) => sum + pointsOf(s.optionId), 0)
    : staged.length;
  const willComplete = have + stagedWorth >= required;

  async function submit() {
    if (willComplete && !(await confirm(
      `This is the last piece of evidence for "${tileName}". Submitting it ` +
      'completes the tile and fires the shot.',
      { title: 'Fire the shot?', confirmLabel: 'Submit & fire' }
    ))) return;

    setBusy(true);
    setError(null);
    try {
      // Sequentially: parallel uploads racing the same locked-in tile is a good way
      // sail past the required count and confuse the person doing it.
      let last = null;
      for (const item of staged) {
        last = await uploadEvidence({
          gameId, teamId, claimId, file: item.file, optionId: item.optionId,
        });
      }
      setStaged([]);
      // add_evidence() fires the shot itself once the requirement is met, and
      // says so. `completed` is what the caller falls back on if it did not.
      await onUploaded?.({
        completed: willComplete,
        fired: Boolean(last?.fired),
        result: last?.result ?? null,
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="evidence">
      <p className="evidence-count">
        {weighted ? 'Points' : 'Evidence'}{' '}
        <strong className={done ? 'met' : ''}>{have} / {required}</strong>
        {!done && stagedWorth > 0 && (
          <span className="muted"> (+{stagedWorth} staged)</span>
        )}
        {!done && <span className="muted"> — needed before you can fire</span>}
      </p>

      {/* The price list. Shown only once the tile is locked in, because these
          labels are tile content — tiles_for_me redacts them for every square
          this team has not claimed. Repeats are allowed, so this is a menu of
          what things are worth, not a checklist to tick off. */}
      {weighted && staged.length === 0 && (
        <ul className="evidence-options">
          {options.map((o) => (
            <li key={o.id}>
              <span>{o.label}</span>
              <span className="muted">{o.points} pts</span>
            </li>
          ))}
        </ul>
      )}

      {/* Who submitted is recorded on every row and shown on the organiser's
          review screen. It is not repeated here: the count is the only part
          the team acts on, and this card is already tall. */}
      {staged.length > 0 ? (
        <div className="evidence-staged">
          {weighted ? (
            <ul className="evidence-staged-list">
              {staged.map((item, i) => (
                <li key={i}>
                  {/* No filename here on purpose. It is squeezed to a character
                      or two by the card width, tells the player nothing they
                      did not just do, and the drop picker is the only part of
                      this row anyone acts on. */}
                  <select
                    value={item.optionId ?? ''}
                    disabled={busy}
                    onChange={(e) => {
                      const optionId = e.target.value || null;
                      setStaged((s) => s.map((x, j) => (j === i ? { ...x, optionId } : x)));
                    }}
                  >
                    <option value="">Which drop?</option>
                    {options.map((o) => (
                      <option key={o.id} value={o.id}>{o.label} — {o.points} pts</option>
                    ))}
                  </select>
                  <button
                    className="ghost"
                    aria-label="Remove"
                    disabled={busy}
                    onClick={() => setStaged((s) => s.filter((_, j) => j !== i))}
                  >
                    &times;
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <span className="evidence-staged-name">
              {staged.length === 1
                ? (staged[0].file.name || 'Screenshot')
                : `${staged.length} screenshots`}
            </span>
          )}
          <div className="row">
            <button className="ghost" onClick={() => setStaged([])} disabled={busy}>
              Remove
            </button>
            <button onClick={submit} disabled={busy || !allAssigned}>
              {busy
                ? (willComplete ? 'Firing…' : 'Submitting…')
                : (willComplete ? 'Submit & fire' : 'Submit')}
            </button>
          </div>
          {!allAssigned && (
            <p className="muted">Say which drop each screenshot shows before submitting.</p>
          )}
        </div>
      ) : (
        <div
          className={`evidence-drop${dragging ? ' over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            stage(e.dataTransfer.files);
          }}
        >
          Drop a screenshot, paste, or{' '}
          <button
            type="button"
            className="link"
            onClick={(e) => { inputRef.current?.click(); }}
          >
            choose a file
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => { stage(e.target.files); e.target.value = ''; }}
          />
        </div>
      )}

      {error && <p className="error">{error}</p>}
      {confirmDialog}
    </div>
  );
});

export default EvidenceUploader;
