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

  /**
   * "Saved." is a receipt, and a receipt goes stale.
   *
   * It used to stand until the team's name or id changed, so a save from ten
   * minutes ago looked exactly like one from a second ago — which matters on
   * the console, where an organiser renaming both teams has two of these side
   * by side and the only thing distinguishing "this one saved" from "that one
   * did" is which message is still up.
   */
  useEffect(() => {
    if (!saved) return undefined;
    const id = setTimeout(() => setSaved(false), 4000);
    return () => clearTimeout(id);
  }, [saved]);

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
