import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * In-app confirmation, replacing window.confirm and window.prompt.
 *
 * Native dialogs cannot be relied on. A WebView shows them only if its host
 * implements the JS-dialog delegate, and where the host does not,
 * `window.confirm()` returns **false immediately without drawing anything** --
 * measured at 1ms in this app's own embedded browser. The caller cannot tell
 * that apart from someone pressing Cancel, so the action silently does nothing.
 *
 * That mattered more here than it usually would, because both halves of the
 * player loop were gated on it: claiming a tile, and the submit that fires the
 * shot. Worse, the gate was asymmetric -- a submit that does not complete a
 * tile never asked -- so a player in an in-app browser could upload the first
 * two pieces of evidence normally and then find the third silently refusing,
 * with no error to report to an organiser. The Discord link is the obvious way
 * a clan reaches this site, and an in-app browser is where that link lands.
 *
 * Promise-based, so the call sites keep the shape they already had:
 *
 *   if (!(await confirm('Claim A1?'))) return;
 *
 * `requireText` reproduces the type-the-name guard that game deletion used
 * window.prompt for. It is slightly stricter than the original: the confirm
 * button stays disabled until the text matches, rather than accepting anything
 * and reporting the mismatch afterwards.
 */

export function useConfirm() {
  const [request, setRequest] = useState(null);
  const resolveRef = useRef(null);

  const confirm = useCallback((message, opts = {}) => {
    return new Promise((resolve) => {
      resolveRef.current = resolve;
      setRequest({ message, ...opts });
    });
  }, []);

  const settle = useCallback((answer) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setRequest(null);
    resolve?.(answer);
  }, []);

  // An unmount while a question is open would leave the caller awaiting a
  // promise that can never settle, and with it whatever `busy` flag it set
  // before asking. Answering "no" is the safe reading of a screen that went
  // away mid-question.
  useEffect(() => () => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    resolve?.(false);
  }, []);

  const dialog = request ? (
    <ConfirmDialog
      {...request}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  ) : null;

  return [confirm, dialog];
}

function ConfirmDialog({
  message, title, confirmLabel, cancelLabel, danger, requireText,
  onConfirm, onCancel,
}) {
  const [typed, setTyped] = useState('');
  const confirmRef = useRef(null);
  const inputRef = useRef(null);

  const satisfied = !requireText || typed.trim() === requireText;

  // Escape cancels, wherever focus happens to be. Enter is deliberately not
  // bound: this dialog stands in front of irreversible actions, and the whole
  // point is a second deliberate press rather than a reflex on the key that
  // submitted the form behind it.
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  useEffect(() => {
    (requireText ? inputRef : confirmRef).current?.focus();
  }, [requireText]);

  return (
    <div
      className="confirm-backdrop"
      // A press outside the dialog cancels, matching what people expect of a
      // sheet on a phone. Only on the backdrop itself, never a bubbled press
      // from inside the panel.
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        className={`confirm${danger ? ' danger' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
      >
        <h3 id="confirm-title">{title ?? 'Are you sure?'}</h3>
        <p className="confirm-message">{message}</p>

        {requireText && (
          <label className="confirm-typed">
            <span className="muted">Type <strong>{requireText}</strong> to confirm</span>
            <input
              ref={inputRef}
              type="text"
              value={typed}
              autoComplete="off"
              onChange={(e) => setTyped(e.target.value)}
            />
          </label>
        )}

        <div className="confirm-actions">
          <button className="ghost" onClick={onCancel}>
            {cancelLabel ?? 'Cancel'}
          </button>
          <button
            ref={confirmRef}
            className={danger ? 'danger' : ''}
            disabled={!satisfied}
            onClick={onConfirm}
          >
            {confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmDialog;
