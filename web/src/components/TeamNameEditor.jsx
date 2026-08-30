import { useEffect, useState } from 'react';
import { renameTeam } from '../lib/supabase.js';

/** Shared editor: authorization is enforced again inside rename_team(). */
export default function TeamNameEditor({ team, onRenamed }) {
  const [name, setName] = useState(team.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setName(team.name);
    setError(null);
    setSaved(false);
  }, [team.id, team.name]);

  const nextName = name.trim();
  const changed = nextName !== team.name;

  async function submit(event) {
    event.preventDefault();
    if (!changed || !nextName) return;

    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const renamed = await renameTeam(team.id, nextName);
      setName(renamed);
      setSaved(true);
      await onRenamed?.(renamed);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="team-name-editor" onSubmit={submit}>
      <label>
        Team name
        <input
          value={name}
          maxLength={50}
          onChange={(event) => { setName(event.target.value); setSaved(false); }}
        />
      </label>
      <button type="submit" disabled={busy || !changed || !nextName}>
        {busy ? 'Saving…' : 'Save name'}
      </button>
      {error && <p className="error">{error}</p>}
      {saved && <p className="muted">Saved.</p>}
    </form>
  );
}
