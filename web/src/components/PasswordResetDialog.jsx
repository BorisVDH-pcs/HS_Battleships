import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * The popup behind Accounts' "Reset password" button.
 *
 * Deliberately no "type the name to confirm" guard, unlike ConfirmDialog's
 * `requireText` — the admin picked this exact player from a list one field
 * up, and there is only one admin account, never shared, so the failure mode
 * that guard exists for (a slip of a shared or careless finger) is not the
 * risk here. What replaces it is the log this action writes server-side.
 */
export default function PasswordResetDialog({ player, busy, onSave, onCancel }) {
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const inputRef = useRef(null);
  const panelRef = useRef(null);

  const tooShort = password.length > 0 && password.length < 8;
  const canSave = password.length >= 8 && !busy;

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); onCancel(); } }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Same reasoning as ConfirmDialog: give focus back to whatever opened this
  // rather than leaving it on <body> once the popup closes.
  const openerRef = useRef(undefined);
  if (openerRef.current === undefined) openerRef.current = document.activeElement;
  useEffect(() => () => {
    const opener = openerRef.current;
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
  }, []);

  return createPortal(
    <div
      className="confirm-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div ref={panelRef} className="confirm" role="dialog" aria-modal="true" aria-labelledby="reset-pw-title">
        <h3 id="reset-pw-title">Reset password for {player.display_name}</h3>
        <p className="confirm-message">
          They'll need this the next time they sign in — nothing changes for them until then.
        </p>

        <label className="confirm-typed">
          <span className="muted">New password</span>
          <span className="password-field">
            <input
              ref={inputRef}
              type={showPassword ? 'text' : 'password'}
              value={password}
              minLength={8}
              autoComplete="new-password"
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && canSave) onSave(password); }}
            />
            <button
              type="button"
              className="link password-reveal"
              onClick={() => setShowPassword((s) => !s)}
            >
              {showPassword ? 'Hide' : 'Show'}
            </button>
          </span>
          {tooShort && <span className="field-error">At least 8 characters.</span>}
        </label>

        <div className="confirm-actions">
          <button className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button disabled={!canSave} onClick={() => onSave(password)}>
            {busy ? 'Saving…' : 'Set new password'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
