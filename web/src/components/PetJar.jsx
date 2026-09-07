import { useEffect, useRef, useState } from 'react';
import { uploadPetJar } from '../lib/petJar.js';
import { fromPosition, coordLabel } from '../lib/board.js';
import TileIcon from './TileIcon.jsx';

/**
 * The pet jar: a second, smaller submission flow alongside proof evidence.
 * Submitting a pet or jar screenshot earns one preview — spending it shows a
 * still-unclaimed tile's task, without ever saying whether it hides a ship.
 *
 * Deliberately not a reuse of EvidenceUploader: a submission here isn't proof
 * against a claimed tile, so there is no claim id, no required count, no
 * "submit fires the shot" moment — just a counter going up or down by one.
 *
 * Spending is not done here. A preview is spent on a square, and the squares
 * are on the board — so this card only turns the picking mode on and off, and
 * App runs the spend against whichever square is pressed. See `pickMode`.
 */
export default function PetJar({
  gameId, teamId, count, tiles, onRefresh,
  pickMode = false, onPickMode, preview, onDismissPreview,
}) {
  const [staged, setStaged] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);
  const zoneRef = useRef(null);

  function stage(files) {
    const image = [...files].find((f) => f.type.startsWith('image/'));
    if (!image) {
      if (files.length) setError('That was not an image.');
      return;
    }
    setError(null);
    setStaged(image);
  }

  /**
   * Paste-to-attach.
   *
   * The dependency array is `[staged]` rather than absent: with none at all
   * this re-bound the listener after every render of the card — including the
   * ones a parent refresh causes, several a minute on a live board — and each
   * pass tore the old listener off and added a new one. `staged` is what
   * actually changes the node this attaches to, because the zone is unmounted
   * while a file is waiting to be sent.
   */
  useEffect(() => {
    const el = zoneRef.current;
    if (!el) return undefined;
    function onPaste(e) {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) { e.preventDefault(); stage(files); }
    }
    el.addEventListener('paste', onPaste);
    return () => el.removeEventListener('paste', onPaste);
  }, [staged]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await uploadPetJar({ gameId, teamId, file: staged });
      setStaged(null);
      onRefresh?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // A tile this team could still spend a preview on: not claimed by us, not
  // already previewed. Previewed-but-unclaimed tiles already carry name/icon
  // (0039), so they are listed below rather than offered again.
  const targets = tiles.filter((t) => !t.revealed && !t.previewed);
  const previewed = tiles.filter((t) => {
    if (!t.previewed || t.revealed) return false;
    const { row, col } = fromPosition(t.position);
    return coordLabel(row, col) !== preview?.coord;
  });

  return (
    <section className="pet-jar" id="pet-jar-section">
      {/* The number used to stand on its own beside the heading, which left it
          reading as a count of submissions made rather than of previews still
          in hand — the opposite direction. */}
      <h2>
        Pet or Jar Submission
        <span className="pet-jar-count">
          {count} preview{count === 1 ? '' : 's'}
        </span>
      </h2>

      {staged ? (
        <div className="evidence-staged">
          <span className="evidence-staged-name">{staged.name}</span>
          <div className="row">
            <button className="ghost" onClick={() => setStaged(null)} disabled={busy}>
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
        >
          Drop a pet/jar screenshot, paste, or{' '}
          <button
            type="button"
            className="link"
            onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}
          >
            choose a file
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => { stage(e.target.files); e.target.value = ''; }}
          />
        </div>
      )}

      {/* Spending used to be a hundred-option dropdown of coordinates, which
          asked a player to read "F7" off the board and then find it again in a
          list — a coordinate is what you say out loud, not how you point. The
          board is the picker. */}
      {count > 0 && targets.length > 0 && (
        pickMode ? (
          <div className="pet-jar-spend">
            <span className="pet-jar-picking" role="status">
              Pick a square on the enemy board.
            </span>
            <button className="ghost" onClick={() => onPickMode?.(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="pet-jar-spend">
            <button onClick={() => onPickMode?.(true)}>Preview a square…</button>
          </div>
        )
      )}

      {preview && (
        <p className="pet-jar-preview">
          <TileIcon slug={preview.icon} standIn />
          <strong>{preview.name}</strong>
          <span className="muted">{preview.coord}</span>
          <button
            className="link pet-jar-preview-dismiss"
            onClick={() => onDismissPreview?.()}
            aria-label="Dismiss this preview"
          >
            ✕
          </button>
        </p>
      )}

      {previewed.length > 0 && (
        <ul className="pet-jar-previewed">
          {previewed.map((t) => {
            const { row, col } = fromPosition(t.position);
            return (
              <li key={t.id}>
                <TileIcon slug={t.icon} standIn />
                <span>{t.name} <span className="muted">({coordLabel(row, col)})</span></span>
              </li>
            );
          })}
        </ul>
      )}

      {error && <p className="error">{error}</p>}
    </section>
  );
}
