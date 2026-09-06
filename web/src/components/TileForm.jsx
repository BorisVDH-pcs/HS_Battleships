import { RULES, validateDraft } from '../lib/tileDraft.js';
import IconPicker from './IconPicker.jsx';

/**
 * The one editor for a tile, wherever the tile lives.
 *
 * A catalogue entry and a square on a board are the same fields — the square
 * just also has a coordinate — so they get the same form, and `showTags` is the
 * only thing that differs: tags are how the catalogue is searched and mean
 * nothing on a board.
 *
 * It is deliberately not a wizard. The rule picker changes which fields apply,
 * and the ones the rule does not use are hidden rather than disabled, because a
 * greyed-out "target" beside "any one full set" invites the question of what it
 * would have meant.
 */
export default function TileForm({
  draft, onChange, at = 'This tile', showTags = false,
  busy = false, saveLabel = 'Save', onSave, onCancel, extraActions = null,
  extraErrors = [],
}) {
  const set = (patch) => onChange({ ...draft, ...patch });
  // `extraErrors` is for what only the caller can know — a catalogue name
  // already in use, say. It blocks the save exactly like a rule error, because
  // the alternative is a round trip that comes back with the same answer in
  // the words of a Postgres exception.
  const errors = [...validateDraft(draft, at), ...extraErrors];
  const rule = draft.rule ?? 'points';
  const priced = rule === 'points' && draft.options.length > 0;

  const setOption = (index, patch) => set({
    options: draft.options.map((o, i) => (i === index ? { ...o, ...patch } : o)),
  });

  return (
    <div className="tile-form">
      <label className="field">
        <span>Name</span>
        <input
          value={draft.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="What the team has to do"
          maxLength={120}
        />
      </label>

      <label className="field">
        <span>Icon</span>
        <IconPicker value={draft.icon} onChange={(icon) => set({ icon })} />
      </label>

      <label className="field">
        <span>Explanation <em className="muted">optional</em></span>
        <textarea
          className="tile-form-note"
          value={draft.description}
          onChange={(e) => set({ description: e.target.value })}
          placeholder="Shown behind the ? once a team locks the tile in. Say what counts, not what it costs."
          maxLength={500}
        />
      </label>

      <label className="field">
        <span>How it finishes</span>
        <select value={rule} onChange={(e) => set({ rule: e.target.value })}>
          {RULES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
      </label>
      <p className="muted tile-form-hint">
        {RULES.find((r) => r.value === rule)?.hint}
      </p>

      {(rule === 'points' || rule === 'value') && (
        <label className="field">
          <span>{rule === 'value' ? 'Target in millions' : priced ? 'Target in points' : 'Screenshots needed'}</span>
          <input
            type="number" min="1" max={rule === 'value' ? 1000 : 30}
            value={draft.amount}
            onChange={(e) => set({ amount: e.target.value })}
          />
        </label>
      )}

      {rule === 'each_set' && (
        <label className="field">
          <span>Different drops per set</span>
          <input
            type="number" min="1" max="30"
            value={draft.perSet}
            onChange={(e) => set({ perSet: e.target.value })}
          />
        </label>
      )}

      {/* Only where it can apply. Combining an early finish with a rule that
          already says when the tile is done is rejected by the parser, the
          database and validateDraft alike — so it should not be offerable. */}
      {rule === 'points' && !priced && (
        <label className="field-inline">
          <input
            type="checkbox"
            checked={draft.early}
            onChange={(e) => set({ early: e.target.checked })}
          />
          <span>
            A cheaper route exists — the target is the worst case, and the team
            gets a <em>Complete Early</em> button after its first screenshot.
          </span>
        </label>
      )}

      <div className="tile-form-drops">
        <div className="row">
          <h4>
            Drops
            {rule === 'points' && <em className="muted"> — priced, optional</em>}
            {(rule === 'one_set' || rule === 'each_set') && <em className="muted"> — grouped into sets</em>}
          </h4>
          {rule !== 'value' && (
            <button
              type="button" className="ghost"
              onClick={() => set({ options: [...draft.options, { label: '', points: '1', grp: '' }] })}
            >
              Add drop
            </button>
          )}
        </div>

        {rule === 'value' ? (
          <p className="muted">
            A value tile has no drop list — the team types what each one was worth.
          </p>
        ) : draft.options.length === 0 ? (
          <p className="muted">
            {rule === 'points'
              ? 'None. The tile finishes on a count of screenshots.'
              : 'A set rule needs its drops. Add the ones that make up each set.'}
          </p>
        ) : (
          <ul className="drop-rows">
            {draft.options.map((option, index) => (
              <li key={index}>
                {rule !== 'points' && (
                  <input
                    className="drop-grp"
                    value={option.grp}
                    onChange={(e) => setOption(index, { grp: e.target.value })}
                    placeholder="Set"
                    maxLength={40}
                  />
                )}
                <input
                  className="drop-label"
                  value={option.label}
                  onChange={(e) => setOption(index, { label: e.target.value })}
                  placeholder="Drop"
                  maxLength={80}
                />
                {rule === 'points' && (
                  <input
                    className="drop-points"
                    type="number" min="1" max="30"
                    value={option.points}
                    onChange={(e) => setOption(index, { points: e.target.value })}
                    aria-label="Points"
                  />
                )}
                <button
                  type="button" className="ghost drop-remove"
                  onClick={() => set({ options: draft.options.filter((_, i) => i !== index) })}
                  aria-label={`Remove ${option.label || 'this drop'}`}
                >
                  &times;
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {showTags && (
        <label className="field">
          <span>Tags <em className="muted">optional, comma separated</em></span>
          <input
            value={draft.tags}
            onChange={(e) => set({ tags: e.target.value })}
            placeholder="raids, barrows, slayer"
          />
        </label>
      )}

      {errors.length > 0 && (
        <ul className="error">
          {errors.map((message) => <li key={message}>{message}</li>)}
        </ul>
      )}

      <div className="row tile-form-actions">
        <button disabled={busy || errors.length > 0} onClick={onSave}>{saveLabel}</button>
        {extraActions}
        {onCancel && <button className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>}
      </div>
    </div>
  );
}
