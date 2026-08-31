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
  const [mode, setMode] = useState('signin');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setMessage(null);

    const invalid = validateUsername(username);
    if (invalid) { setMessage(invalid); return; }

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
          <input
            type="password"
            value={password}
            required
            minLength={8}
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? '…' : mode === 'signin' ? 'Sign in' : 'Create account'}
        </button>
      </form>

      <button
        className="link"
        onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setMessage(null); }}
      >
        {mode === 'signin' ? 'Need an account?' : 'Already have an account?'}
      </button>

      {message && <p className="message">{message}</p>}

      {mode === 'signin' && (
        <p className="muted forgot">
          Forgotten your password? There is no reset email — ask an admin to set a new one.
        </p>
      )}
    </div>
  );
}
