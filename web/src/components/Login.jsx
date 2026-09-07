import { useState } from 'react';
import Wordmark from './Wordmark.jsx';
import { supabase } from '../lib/supabase.js';
import { usernameToEmail, validateUsername, friendlyAuthError } from '../lib/auth.js';

/**
 * Username + password. No email anywhere — see lib/auth.js for how the username
 * is mapped onto Supabase Auth, and why password resets have to go through an
 * admin.
 */
export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // Sign-up only. There is no password reset in this app -- the addresses are
  // synthetic, so there is no mailbox to send a link to -- which makes a typo
  // here the one mistake on this screen that cannot be undone by the person
  // who made it. Two independent guards against that: type it twice, and be
  // able to read what you typed.
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [mode, setMode] = useState('signin');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const signingUp = mode === 'signup';
  // Held back until they have typed something, so the mismatch does not
  // accuse them of an error while they are still on the first character.
  const mismatch = signingUp && confirmPassword.length > 0
    && password !== confirmPassword;

  async function submit(e) {
    e.preventDefault();
    setMessage(null);

    const invalid = validateUsername(username);
    if (invalid) { setMessage(invalid); return; }

    // Checked here as well as by the disabled button: a form can still be
    // submitted with Enter from a field the button never saw.
    if (signingUp && password !== confirmPassword) {
      setMessage('The two passwords do not match.');
      return;
    }

    setBusy(true);
    try {
      const email = usernameToEmail(username);

      if (mode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          // Copied into the profiles row by the on_auth_user_created trigger.
          options: { data: { display_name: username.trim(), rsn: username.trim() } },
        });
        if (error) throw error;

        if (data.session) {
          setMessage('Account created.');
        } else {
          // No session means Supabase is still waiting on a confirmation it can
          // never deliver, because these addresses are synthetic.
          setMessage(
            'Account created, but sign-in is blocked until an admin turns off ' +
              'email confirmation in Supabase.'
          );
        }
      }
    } catch (err) {
      setMessage(friendlyAuthError(err.message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <Wordmark />
      <form onSubmit={submit}>
        <label>
          Username
          <input
            type="text"
            value={username}
            required
            autoComplete="username"
            placeholder="Your RuneScape name"
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label>
          Password
          <span className="password-field">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              required
              minLength={8}
              autoComplete={signingUp ? 'new-password' : 'current-password'}
              onChange={(e) => setPassword(e.target.value)}
            />
            {/* Inside the label, so pressing it does not steal the click from
                the field it belongs to. type="button" because everything in a
                form submits it otherwise, and this one is here precisely to
                stop people submitting a password they cannot see. */}
            <button
              type="button"
              className="link password-reveal"
              aria-pressed={showPassword}
              onClick={() => setShowPassword((s) => !s)}
            >
              {showPassword ? 'Hide' : 'Show'}
            </button>
          </span>
        </label>

        {signingUp && (
          <label>
            Confirm password
            <input
              type={showPassword ? 'text' : 'password'}
              value={confirmPassword}
              required
              autoComplete="new-password"
              aria-invalid={mismatch || undefined}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
            {mismatch && (
              <span className="field-error">The two passwords do not match.</span>
            )}
          </label>
        )}

        <button type="submit" disabled={busy || mismatch}>
          {busy
            ? (signingUp ? 'Creating account…' : 'Signing in…')
            : (signingUp ? 'Create account' : 'Sign in')}
        </button>
      </form>

      <button
        className="link"
        onClick={() => {
          setMode(signingUp ? 'signin' : 'signup');
          setMessage(null);
          // Dropped rather than carried across: it belongs to a form that is
          // no longer on screen, and leaving it filled would let a mismatch
          // survive into the mode that cannot show it.
          setConfirmPassword('');
        }}
      >
        {signingUp ? 'Already have an account?' : 'Need an account?'}
      </button>

      {/* role="alert" because this is the only report a failed sign-in gets.
          Without it the message is painted into a corner of the page that a
          screen reader has already read past, and someone who has zoomed in
          on the form never learns the press did anything at all. */}
      {message && <p className="message" role="alert">{message}</p>}

      {!signingUp && (
        <p className="muted forgot">
          Forgotten your password? There is no reset email — ask an admin to set a new one.
        </p>
      )}
    </div>
  );
}
