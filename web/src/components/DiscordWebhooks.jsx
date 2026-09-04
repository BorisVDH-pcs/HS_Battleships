import { useCallback, useEffect, useState } from 'react';
import { adminListWebhooks, adminSetWebhook, adminDeleteWebhook } from '../lib/supabase.js';

/**
 * One row for the general channel (both teams see: shot_fired, ship_sunk,
 * game_won, etc. — see is_team_private_event in 0036/0039) plus one row per
 * team (evidence_submitted and pet_jar_submitted route only there, images
 * included when imgbb is configured — see 0040).
 *
 * Laid out as a settings list rather than a two-column grid: there are three
 * destinations, so two columns always left a hole under the third, and a
 * webhook URL is long enough to want the full width anyway.
 *
 * `onChanged` fires after a webhook is saved or deleted. This panel owns its own
 * rows and reloads them itself, which was self-contained until the setup
 * checklist started reporting whether a game has a webhook at all. That count
 * lives in Admin, so a save here has to say so — otherwise the checklist keeps
 * claiming "none" until the page is reloaded.
 */
export default function DiscordWebhooks({ gameId, gameTeams, onChanged }) {
  const [rows, setRows] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await adminListWebhooks(gameId);
      setRows(data ?? []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoaded(true);
    }
  }, [gameId]);

  // Reload this panel, then tell the parent. Wrapped once so every save and
  // delete below goes through the same path and none can forget the second half.
  const refresh = useCallback(async () => {
    await load();
    onChanged?.();
  }, [load, onChanged]);

  useEffect(() => { setLoaded(false); load(); }, [load]);

  const byTeam = new Map(rows.filter((r) => r.team_id).map((r) => [r.team_id, r]));
  const general = rows.find((r) => !r.team_id) ?? null;

  return (
    <section className="card">
      <h2>Discord webhooks</h2>
      <p className="muted">
        Optional. With none set, this game posts nothing to Discord — which is
        easy to mistake for a fault, so it is worth saying out loud.
      </p>

      {error && <p className="error">{error}</p>}

      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="webhooks">
          <WebhookRow
            title="General"
            note="Everything both teams can see: shots fired, ships sunk, and the win."
            row={general}
            onSave={(url, enabled) => adminSetWebhook(gameId, null, url, enabled).then(refresh)}
            onDelete={general ? () => adminDeleteWebhook(general.id).then(refresh) : null}
          />
          {gameTeams.map((team) => {
            const row = byTeam.get(team.id) ?? null;
            return (
              <WebhookRow
                key={team.id}
                title={team.name}
                note={`Only ${team.name}'s own events: evidence and pet jar submissions, with the screenshot itself when an imgbb key is configured.`}
                row={row}
                onSave={(url, enabled) => adminSetWebhook(gameId, team.id, url, enabled).then(refresh)}
                onDelete={row ? () => adminDeleteWebhook(row.id).then(refresh) : null}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function WebhookRow({ title, note, row, onSave, onDelete }) {
  const [url, setUrl] = useState(row?.url ?? '');
  const [enabled, setEnabled] = useState(row?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setUrl(row?.url ?? '');
    setEnabled(row?.enabled ?? true);
    setError(null);
    setSaved(false);
  }, [row?.id, row?.url, row?.enabled]);

  const changed = url.trim() !== (row?.url ?? '') || enabled !== (row?.enabled ?? true);

  // The badge reports what is actually stored, not what is typed into the box —
  // an organiser checking whether this game will post anything needs the saved
  // state, and `changed` below is what speaks for the unsaved edit.
  const status = !row ? 'none' : row.enabled ? 'on' : 'off';
  const statusLabel = { none: 'Not set', on: 'On', off: 'Paused' }[status];

  async function save() {
    if (!url.trim()) { setError('A webhook needs a URL.'); return; }
    setBusy(true); setError(null); setSaved(false);
    try {
      await onSave(url.trim(), enabled);
      setSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true); setError(null);
    try {
      await onDelete();
      setUrl(''); setEnabled(true); setSaved(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="webhook">
      <div className="webhook-head">
        <h3>{title}</h3>
        <span className={`pill webhook-status ${status}`}>{statusLabel}</span>
      </div>
      <p className="webhook-note">{note}</p>

      <label className="webhook-url">
        Webhook URL
        <input
          type="password"
          value={url}
          placeholder="https://discord.com/api/webhooks/…"
          autoComplete="off"
          onChange={(e) => { setUrl(e.target.value); setSaved(false); }}
        />
      </label>

      {/* A settings row: what it does on the left, the control on the trailing
          edge. The switch is a checkbox underneath, so it keeps the keyboard
          and screen-reader behaviour the platform already gives one. */}
      <div className="switch-row">
        <span className="switch-label">
          Post to this channel
          <span className="muted">
            {enabled ? 'Events are delivered here.' : 'Nothing is sent while this is off.'}
          </span>
        </span>
        <label className="switch">
          <input
            type="checkbox"
            role="switch"
            checked={enabled}
            aria-label={`Post ${title} events to Discord`}
            onChange={(e) => { setEnabled(e.target.checked); setSaved(false); }}
          />
          <span className="switch-track" aria-hidden="true" />
        </label>
      </div>

      <div className="webhook-actions">
        <button disabled={busy || !changed} onClick={save}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        {onDelete && (
          <button className="danger" disabled={busy} onClick={remove}>
            Remove
          </button>
        )}
        {changed && !busy && <span className="webhook-dirty">Unsaved changes</span>}
        {saved && !changed && <span className="webhook-saved">Saved</span>}
      </div>

      {error && <p className="error">{error}</p>}
    </article>
  );
}
