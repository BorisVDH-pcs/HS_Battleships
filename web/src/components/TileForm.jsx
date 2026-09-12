import { RULES, validateDraft, ruleSummary } from '../lib/tileDraft.js';
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

  /**
   * The sentence the team will read, in the words the card will use.
   *
   * `ruleSummary` is reused rather than reworded, so this cannot drift from
   * what the slot card and the catalogue list actually say. It has to be fed a
   * row though, not a payload: the two shapes name the same things
   * differently — `completion`/`required_evidence`/`per_set` on the row against
   * `rule`/`amount`/`perSet` on the payload — so handing it a payload gets
   * every field back as undefined and a confident "1 screenshot" for every
   * tile ever typed.
   *
   * Blank drops are dropped first, because an empty row added by "Add drop"
   * would otherwise turn a plain tile into a priced one and change the
   * sentence to points before anything had been typed into it.
   */
  const summary = ruleSummary({
    completion: rule,
    required_evidence: Number(draft.amount) || 1,
    per_set: Number(draft.perSet) || 1,
    options: (draft.options ?? []).filter((o) => (o.label ?? '').trim()),
  });

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

      {/* What the team will actually be told this tile needs.
       *
       * The hint above explains the rule in general; this is the sentence that
       * ends up on their card, built by the same `ruleSummary` the card and
       * the catalogue list use — so it cannot drift from what they read, the
       * way a hand-written second copy of the card would. Which matters here
       * because the rule fields interact: an amount means screenshots on a
       * bare tile and points on a priced one, and the difference is invisible
       * in the inputs.
       */}
      {summary && (
        <p className="tile-form-summary">
          Players will see: <b>{summary}</b>
        </p>
      )}

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

      {(rule === 'each_set' || rule === 'points_per_set') && (
        <label className="field">
          {/* Same field, and the wording is the whole difference between the
              two rules — so it says which one this is rather than leaving the
              reader to remember. */}
          <span>
            {rule === 'each_set' ? 'Different drops per set' : 'Points per set'}
          </span>
          <input
            type="number" min="1" max="30"
            value={draft.perSet}
            onChange={(e) => set({ perSet: e.target.value })}
          />
        </label>
      )}

      <div className="tile-form-drops">
        <div className="row">
          <h4>
            Drops
            {rule === 'points' && <em className="muted"> — priced, optional</em>}
            {(rule === 'one_set' || rule === 'each_set') && <em className="muted"> — grouped into sets</em>}
            {rule === 'points_per_set' && <em className="muted"> — grouped into sets, priced</em>}
          </h4>
          {rule !== 'value' && (
            <button
              type="button" className="ghost"
              onClick={() => set({
                options: [...draft.options, { label: '', points: '1', grp: '', maxTimes: '' }],
              })}
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
          <>
            {/* The two number boxes on each row are easy to mix up, and the
                second one is new. Said once, above the list, rather than as a
                label on every row — which is what the column widths are for. */}
            {(rule === 'points' || rule === 'points_per_set') && (
              <p className="muted tile-form-hint">
                Two numbers per drop: what it is worth, then how many times it
                may count. Leave the second blank for no limit.
              </p>
            )}
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
                {(rule === 'points' || rule === 'points_per_set') && (
                  <>
                    <input
                      className="drop-points"
                      type="number" min="1" max="30"
                      value={option.points}
                      onChange={(e) => setOption(index, { points: e.target.value })}
                      aria-label="Points"
                    />
                    {/* Empty means uncapped, which is why the placeholder is a
                        symbol rather than a number: a "1" sitting there greyed
                        out reads as the current value, and the difference
                        between "once" and "as often as you like" is the whole
                        point of the field. */}
                    <input
                      className="drop-max"
                      type="number" min="1" max="30"
                      placeholder="∞"
                      value={option.maxTimes ?? ''}
                      onChange={(e) => setOption(index, { maxTimes: e.target.value })}
                      aria-label={`How many times ${option.label || 'this drop'} may count`}
                      title="How many times this drop may count. Blank for no limit."
                    />
                  </>
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
          </>
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
