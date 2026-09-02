import { useEffect, useRef, useState } from 'react';
import { uploadPetJar } from '../lib/petJar.js';
import { spendPetJar } from '../lib/supabase.js';
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
 */
export default function PetJar({ gameId, teamId, count, tiles, onRefresh }) {
  const [staged, setStaged] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState('');
  const [preview, setPreview] = useState(null); // last spend result, shown inline
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

  // A tile this team could still claim: not claimed by us, not already
  // previewed. Previewed-but-unclaimed tiles already carry name/icon (0039),
  // so they are listed separately below rather than offered again.
  const claimable = tiles.filter((t) => !t.revealed && !t.previewed);
  const previewed = tiles.filter((t) => t.previewed && !t.revealed);

  async function spend() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const result = await spendPetJar(selected);
      setPreview(result);
      setSelected('');
      onRefresh?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="pet-jar">
      <h2>Pet jar <span className="pet-jar-count">{count}</span></h2>

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
          className="evidence-drop"
          tabIndex={0}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); stage(e.dataTransfer.files); }}
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

      {count > 0 && claimable.length > 0 && (
        <div className="pet-jar-spend">
          <select value={selected} onChange={(e) => setSelected(e.target.value)}>
            <option value="">Preview a tile…</option>
            {claimable.map((t) => {
              const { row, col } = fromPosition(t.position);
              return (
                <option key={t.id} value={t.id}>{coordLabel(row, col)}</option>
              );
            })}
          </select>
          <button onClick={spend} disabled={busy || !selected}>
            {busy ? 'Spending…' : 'Preview'}
          </button>
        </div>
      )}

      {preview && (
        <p className="pet-jar-preview">
          <TileIcon slug={preview.icon} standIn />
          <strong>{preview.name}</strong>
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
