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
 * There are deliberately no thumbnails of submitted evidence here. They made
 * the card nearly twice as tall for something a player has already seen; the
 * organiser's review screen is where the images actually need looking at.
 */
const EvidenceUploader = forwardRef(function EvidenceUploader({
  claimId, gameId, teamId, required, evidence, onUploaded, tileName,
}, ref) {
  const [staged, setStaged] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);
  const [confirm, confirmDialog] = useConfirm();

  const have = evidence.length;
  const done = have >= required;

  function stage(files) {
    const images = [...files].filter((f) => f.type.startsWith('image/'));
    if (!images.length) {
      if (files.length) setError('That was not an image.');
      return;
    }
    setError(null);
    setStaged((s) => [...s, ...images]);
  }

  useImperativeHandle(ref, () => ({ stageFiles: stage }));

  // Computed from what is staged, not from `evidence`, which does not update
  // until the refetch after upload.
  const willComplete = have + staged.length >= required;

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
      for (const file of staged) {
        last = await uploadEvidence({ gameId, teamId, claimId, file });
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
        Evidence <strong className={done ? 'met' : ''}>{have} / {required}</strong>
        {!done && <span className="muted"> — needed before you can fire</span>}
      </p>

      {/* Who submitted is recorded on every row and shown on the organiser's
          review screen. It is not repeated here: the count is the only part
          the team acts on, and this card is already tall. */}
      {staged.length > 0 ? (
        <div className="evidence-staged">
          <span className="evidence-staged-name">
            {staged.length === 1 ? staged[0].name : `${staged.length} screenshots`}
          </span>
          <div className="row">
            <button className="ghost" onClick={() => setStaged([])} disabled={busy}>
              Remove
            </button>
            <button onClick={submit} disabled={busy}>
              {busy
                ? (willComplete ? 'Firing…' : 'Submitting…')
                : (willComplete ? 'Submit & fire' : 'Submit')}
            </button>
          </div>
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
