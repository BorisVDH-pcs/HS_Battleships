import { useState } from 'react';
import { supabase } from '../lib/supabase.js';

/** Email + password sign-in. Every player has their own account. */
export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rsn, setRsn] = useState('');
  const [mode, setMode] = useState('signin');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      if (mode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        // rsn lands in raw_user_meta_data, which the on_auth_user_created
        // trigger copies into the profiles row.
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { rsn: rsn.trim(), display_name: rsn.trim() } },
        });
        if (error) throw error;
        setMessage(
          data.session
            ? 'Account created.'
            : 'Account created — check your email to confirm, then sign in.'
        );
      }
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <h1>HS Battleships</h1>
      <form onSubmit={submit}>
        <label>
          Email
          <input type="email" value={email} required
                 onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Password
          <input type="password" value={password} required minLength={8}
                 onChange={(e) => setPassword(e.target.value)} />
        </label>
        {mode === 'signup' && (
          <label>
            RuneScape name
            <input type="text" value={rsn} required
                   placeholder="Your in-game name"
                   onChange={(e) => setRsn(e.target.value)} />
          </label>
        )}
        <button type="submit" disabled={busy}>
          {busy ? '…' : mode === 'signin' ? 'Sign in' : 'Create account'}
        </button>
      </form>
      <button className="link" onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}>
        {mode === 'signin' ? 'Need an account?' : 'Already have an account?'}
      </button>
      {message && <p className="message">{message}</p>}
    </div>
  );
}
