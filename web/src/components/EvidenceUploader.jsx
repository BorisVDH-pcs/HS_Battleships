import { useEffect, useRef, useState } from 'react';
import { uploadEvidence } from '../lib/evidence.js';

/**
 * Attaching proof to an active tile.
 *
 * Three ways in, because people submit screenshots three ways: drag onto the
 * card, pick a file, or paste. Paste matters most — a fresh screenshot is on
 * the clipboard already, and asking someone to save it to disk first is asking
 * them not to bother.
 *
 * Dropping a file STAGES it; a second press submits it. That is what makes a
 * remove button possible at all: submitted evidence is immutable by design
 * (tile_evidence has a select policy and nothing else), so the only safe place
 * to change your mind is before it is uploaded. It also means a misdropped
 * screenshot is not permanently attached to the wrong tile.
 *
 * There are deliberately no thumbnails of submitted evidence here. They made
 * the card nearly twice as tall for something a player has already seen; the
 * organiser's review screen is where the images actually need looking at.
 */
export default function EvidenceUploader({
  claimId, gameId, teamId, required, evidence, onUploaded,
}) {
  const [staged, setStaged] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);
  const zoneRef = useRef(null);

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

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      // Sequentially: parallel uploads racing the same claim is a good way to
      // sail past the required count and confuse the person doing it.
      for (const file of staged) {
        await uploadEvidence({ gameId, teamId, claimId, file });
      }
      setStaged([]);
      onUploaded?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Paste while the card's zone has focus.
  useEffect(() => {
    const el = zoneRef.current;
    if (!el) return;
    function onPaste(e) {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) { e.preventDefault(); stage(files); }
    }
    el.addEventListener('paste', onPaste);
    return () => el.removeEventListener('paste', onPaste);
  });

  const names = [...new Set(evidence.map((e) => e.uploaded_by_name))].join(', ');

  return (
    <div className="evidence">
      <p className="evidence-count">
        Evidence <strong className={done ? 'met' : ''}>{have} / {required}</strong>
        {!done && <span className="muted"> — needed before you can fire</span>}
      </p>

      {/* One muted line instead of a strip of thumbnails: who submitted is the
          part a teammate needs, and it costs a line rather than a row. */}
      {names && <p className="evidence-by">Submitted by {names}</p>}

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
              {busy ? 'Submitting…' : 'Submit'}
            </button>
          </div>
        </div>
      ) : (
        <div
          ref={zoneRef}
          className={`evidence-drop${dragging ? ' over' : ''}`}
          tabIndex={0}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            stage(e.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
        >
          Drop a screenshot, paste, or click to choose
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
    </div>
  );
}
