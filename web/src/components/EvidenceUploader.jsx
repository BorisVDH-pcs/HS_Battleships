import { useEffect, useRef, useState } from 'react';
import { uploadEvidence, signedUrls } from '../lib/evidence.js';

/**
 * Attaching proof to an active tile.
 *
 * Three ways in, because people submit screenshots three ways: drag onto the
 * card, pick a file, or paste. Paste matters most — a fresh screenshot is on
 * the clipboard already, and asking someone to save it to disk first is asking
 * them not to bother.
 *
 * Uploads are append-only. There is no remove button because there is no delete
 * policy behind one: evidence is the record of why a shot counted, so once it
 * is attached it stays. An organiser with the service role can remove something
 * that should never have been there.
 */
export default function EvidenceUploader({
  claimId, gameId, teamId, required, evidence, onUploaded,
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [urls, setUrls] = useState({});
  const inputRef = useRef(null);
  const zoneRef = useRef(null);

  const have = evidence.length;
  const done = have >= required;

  // Signed, not public: the bucket is private and these expire.
  useEffect(() => {
    let cancelled = false;
    const paths = evidence.map((e) => e.storage_path);
    if (!paths.length) { setUrls({}); return; }
    signedUrls(paths)
      .then((map) => { if (!cancelled) setUrls(map); })
      .catch(() => { /* thumbnails are not worth an error banner */ });
    return () => { cancelled = true; };
  }, [evidence]);

  async function send(files) {
    const images = [...files].filter((f) => f.type.startsWith('image/'));
    if (!images.length) return;

    setBusy(true);
    setError(null);
    try {
      // Sequentially: two uploads racing the same claim is a good way to blow
      // past the required count and confuse the person doing it.
      for (const file of images) {
        await uploadEvidence({ gameId, teamId, claimId, file });
      }
      onUploaded?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Paste anywhere while this card's zone has focus.
  useEffect(() => {
    const el = zoneRef.current;
    if (!el) return;
    function onPaste(e) {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) { e.preventDefault(); send(files); }
    }
    el.addEventListener('paste', onPaste);
    return () => el.removeEventListener('paste', onPaste);
  });

  return (
    <div className="evidence">
      <p className="evidence-count">
        Evidence <strong className={done ? 'met' : ''}>{have} / {required}</strong>
        {!done && <span className="muted"> — needed before you can fire</span>}
      </p>

      {evidence.length > 0 && (
        <ul className="evidence-list">
          {evidence.map((e) => (
            <li key={e.id}>
              <a href={urls[e.storage_path]} target="_blank" rel="noreferrer"
                 title={`Uploaded by ${e.uploaded_by_name}`}>
                {urls[e.storage_path]
                  ? <img src={urls[e.storage_path]} alt="" loading="lazy" />
                  : <span className="evidence-pending" />}
              </a>
              <span className="evidence-by">{e.uploaded_by_name}</span>
            </li>
          ))}
        </ul>
      )}

      <div
        ref={zoneRef}
        className={`evidence-drop${dragging ? ' over' : ''}`}
        tabIndex={0}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          send(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? 'Uploading…' : 'Drop a screenshot, paste, or click to choose'}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => { send(e.target.files); e.target.value = ''; }}
        />
      </div>

      {error && <p className="error">{error}</p>}
    </div>
  );
}
