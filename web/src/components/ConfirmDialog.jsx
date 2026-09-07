import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

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
 * player loop were gated on it: locking in a tile, and the submit that fires the
 * shot. Worse, the gate was asymmetric -- a submit that does not complete a
 * tile never asked -- so a player in an in-app browser could upload the first
 * two pieces of evidence normally and then find the third silently refusing,
 * with no error to report to an organiser. The Discord link is the obvious way
 * a clan reaches this site, and an in-app browser is where that link lands.
 *
 * Promise-based, so the call sites keep the shape they already had:
 *
 *   if (!(await confirm('Lock in A1?'))) return;
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
  const panelRef = useRef(null);

  const satisfied = !requireText || typed.trim() === requireText;

  /**
   * Escape cancels, wherever focus happens to be. Enter is deliberately not
   * bound: this dialog stands in front of irreversible actions, and the whole
   * point is a second deliberate press rather than a reflex on the key that
   * submitted the form behind it.
   *
   * Tab is caught here too. `aria-modal` tells a screen reader the rest of the
   * page is inert; it does nothing whatsoever to the Tab key, so without this
   * a few presses walked focus out of the dialog and onto the board behind it
   * — where the buttons are still real, and the one thing this component
   * exists to prevent is an unconsidered press. Focus is read fresh on every
   * Tab rather than collected once, because the confirm button is disabled
   * until the typed name matches and must not be a stop while it is.
   */
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); return; }
      if (e.key !== 'Tab') return;

      const panel = panelRef.current;
      if (!panel) return;
      const stops = [...panel.querySelectorAll('button, input, a[href], [tabindex]')]
        .filter((el) => !el.disabled && el.tabIndex !== -1);
      if (stops.length === 0) return;

      const first = stops[0];
      const last = stops[stops.length - 1];
      // Focus can start outside the ring entirely — the page behind, after a
      // click on the backdrop — in which case either edge is the way back in.
      const at = stops.indexOf(document.activeElement);
      if (at === -1) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  useEffect(() => {
    (requireText ? inputRef : confirmRef).current?.focus();
  }, [requireText]);

  /**
   * Give focus back to whatever raised the dialog.
   *
   * Without it, answering a question left focus on <body>, so the next Tab
   * started from the top of the page — after "Fire the shot?", from the
   * wordmark, a hundred squares away from the slot that asked. `isConnected`
   * because the answer often removes the trigger: confirming a lock-in
   * re-renders the square that was pressed.
   */
  // Read during the first render rather than in an effect, because the effect
  // that moves focus into the dialog runs first and would make the dialog its
  // own opener.
  const openerRef = useRef(undefined);
  if (openerRef.current === undefined) openerRef.current = document.activeElement;

  useEffect(() => () => {
    const opener = openerRef.current;
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
  }, []);

  // Portaled to <body>, not left where it was raised. Two call sites sit
  // inside the active-tile column, and that column is a blurred material
  // (`backdrop-filter`) whose cards also lift on hover (`transform:
  // translateY(-2px)`). Either property makes the ancestor the containing
  // block for `position: fixed` descendants, so this scrim was measured
  // against the card rather than the window — and because the hover transform
  // comes and goes as the pointer moves, the containing block kept switching
  // underneath it, snapping the sheet between the card box and the viewport
  // box. That is the flicker that survived dropping the nested blur: "Fire
  // the shot?" is raised by the uploader inside a slot, which is exactly the
  // affected subtree. The column is its own stacking context too, so z-index
  // 50 could not lift the scrim over the board from in there. Out here it is
  // a plain overlay against the viewport, with no ancestor able to reposition,
  // clip or re-stack it — and no outer backdrop-filter left to nest inside.
  // Same reasoning, and same fix, as the TileInfo panel.
  return createPortal(
    <div
      className="confirm-backdrop"
      // A press outside the dialog cancels, matching what people expect of a
      // sheet on a phone. Only on the backdrop itself, never a bubbled press
      // from inside the panel.
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        ref={panelRef}
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
    </div>,
    document.body,
  );
}

export default ConfirmDialog;
