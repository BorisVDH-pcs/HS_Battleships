import { useCallback, useEffect, useState } from 'react';
import { adminListWebhooks, adminSetWebhook, adminDeleteWebhook } from '../lib/supabase.js';

/**
 * One row for the general channel (both teams see: shot_fired, ship_sunk,
 * game_won, etc. — see is_team_private_event in 0036/0039) plus one row per
 * team (evidence_submitted and pet_jar_submitted route only there, images
 * included when imgbb is configured — see 0040).
 */
export default function DiscordWebhooks({ gameId, gameTeams }) {
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

  useEffect(() => { setLoaded(false); load(); }, [load]);

  const byTeam = new Map(rows.filter((r) => r.team_id).map((r) => [r.team_id, r]));
  const general = rows.find((r) => !r.team_id) ?? null;

  return (
    <section className="card">
      <h2>Discord webhooks</h2>
      <p className="muted">
        The general channel gets game-wide events (shots, sinkings, wins).
        Each team's own channel gets only that team's private events —
        evidence and pet jar submissions — including the screenshot itself,
        when an imgbb key is configured for the build.
      </p>
      {error && <p className="error">{error}</p>}
      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="columns">
          <WebhookRow
            title="General (both teams)"
            row={general}
            onSave={(url, enabled) => adminSetWebhook(gameId, null, url, enabled).then(load)}
            onDelete={general ? () => adminDeleteWebhook(general.id).then(load) : null}
          />
          {gameTeams.map((team) => {
            const row = byTeam.get(team.id) ?? null;
            return (
              <WebhookRow
                key={team.id}
                title={team.name}
                row={row}
                onSave={(url, enabled) => adminSetWebhook(gameId, team.id, url, enabled).then(load)}
                onDelete={row ? () => adminDeleteWebhook(row.id).then(load) : null}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function WebhookRow({ title, row, onSave, onDelete }) {
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
    <div>
      <h3>{title}</h3>
      <label>
        Webhook URL
        <input
          type="password"
          value={url}
          placeholder="https://discord.com/api/webhooks/…"
          onChange={(e) => { setUrl(e.target.value); setSaved(false); }}
        />
      </label>
      <label className="row" style={{ alignItems: 'center', gap: '.4rem' }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => { setEnabled(e.target.checked); setSaved(false); }}
        />
        Enabled
      </label>
      <div className="row" style={{ marginTop: '.4rem' }}>
        <button disabled={busy || !changed} onClick={save}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        {onDelete && (
          <button className="danger" disabled={busy} onClick={remove}>
            Remove
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {saved && <p className="muted">Saved.</p>}
    </div>
  );
}
