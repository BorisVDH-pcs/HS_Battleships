import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { uploadEvidence } from '../lib/evidence.js';
import { MAX_VALUE, MIN_VALUE, millionsToTenths } from '../lib/millions.js';
import {
  completedEachSetGroupNames,
  pointsLabel,
  tileProgress,
  tileShowsPrices,
  unavailableSetOptionIds,
} from '../lib/tileProgress.js';
import { useConfirm } from './ConfirmDialog.jsx';

/**
 * Attaching proof to an active tile.
 *
 * Three ways in, because people submit screenshots three ways: drag onto the
 * card, pick a file, or paste. Paste matters most — a fresh screenshot is on
 * the clipboard already, and asking someone to save it to disk first is asking
 * them not to bother. Which tile a Ctrl+V lands on is decided by which card
 * was clicked last — anywhere on the card, not just this zone — tracked by
 * ActiveTiles and shown with a highlight, since a plain focus ring on a small
 * inner box was easy to miss on a board with several active tiles. This
 * component exposes `stageFiles` via ref so the parent can hand it a pasted
 * clipboard image.
 *
 * Dropping a file STAGES it; a second press submits it. That is what makes a
 * remove button possible at all: submitted evidence is immutable by design
 * (tile_evidence has a select policy and nothing else), so the only safe place
 * to change your mind is before it is uploaded. It also means a misdropped
 * screenshot is not permanently attached to the wrong tile.
 *
 * The submit that meets the requirement also fires the shot — there is no
 * separate "mark complete" press, because by then there is nothing left to
 * say. That submit reads differently and asks first, since it is the
 * irreversible one.
 *
 * WHAT A SCREENSHOT HAS TO SAY (0046, 0049). Three of the four tile rules ask
 * the submitter for something beyond the image:
 *
 *   points / set rules — which drop it shows, picked from the tile's list. The
 *     picker is per file rather than per submit because one submit can carry a
 *     rare and a common together, and a single selection for the whole batch
 *     would quietly mis-score exactly the mixed case weighted tiles exist for.
 *     On a set tile the options are grouped by set and anything already handed
 *     in is disabled, so the picker doubles as the checklist of what is left.
 *
 *   value — what the drop was worth, in millions. Used by the tiles that ask
 *     for an amount of GP, where there is no list of drops to pick from.
 *
 * Numbers shown here are for reading, never for scoring. add_evidence looks up
 * what an option is worth server-side and claim_is_complete decides whether the
 * tile is finished; nothing this component computes is trusted by the database.
 *
 * There are deliberately no thumbnails of submitted evidence here. They made
 * the card nearly twice as tall for something a player has already seen; the
 * organiser's review screen is where the images actually need looking at.
 */
const EvidenceUploader = forwardRef(function EvidenceUploader({
  claimId, gameId, teamId, tile, onUploaded,
}, ref) {
  const [staged, setStaged] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);
  const [confirm, confirmDialog] = useConfirm();

  const tileName = tile.name;
  const options = tile.options ?? [];
  const rule = tile.completion ?? 'points';
  // `isSet` means "a repeat is worth nothing here", which is what the picker
  // and the counter branch on. points_per_set groups like a set and is scored
  // like points, so it is deliberately not one of them.
  const isSet = rule === 'one_set' || rule === 'each_set';
  const isPerSet = rule === 'points_per_set';
  const grouped = isSet || isPerSet;
  const isValue = rule === 'value';
  const picksDrop = options.length > 0;
  // Whether a price is worth printing beside a drop — a whole-tile question,
  // asked once. See tileShowsPrices.
  const priced = tileShowsPrices(tile);

  function stage(files) {
    const images = [...files].filter((f) => f.type.startsWith('image/'));
    if (!images.length) {
      if (files.length) setError('That was not an image.');
      return;
    }
    setError(null);
    // Each file starts unassigned rather than defaulting to the first drop.
    // A wrong default that scores is worse than a picker that waits.
    setStaged((s) => [...s, ...images.map((file) => ({ file, optionId: null, amount: '' }))]);
  }

  useImperativeHandle(ref, () => ({ stageFiles: stage }));

  const pointsOf = (id) => options.find((o) => o.id === id)?.points ?? 0;

  // What is about to be submitted, in the shape tileProgress understands: a
  // number for the rules that sum, a set of option ids for the rules that
  // collect.
  const stagedPoints = isValue
    ? staged.reduce((sum, s) => sum + (millionsToTenths(s.amount) ?? 0), 0)
    : picksDrop
      ? staged.reduce((sum, s) => sum + pointsOf(s.optionId), 0)
      : staged.length;
  const pending = {
    points: stagedPoints,
    optionIds: staged.map((s) => s.optionId).filter(Boolean),
  };

  const now = tileProgress(tile);
  const next = tileProgress(tile, pending);
  const willComplete = next.done;
  const completedGroups = completedEachSetGroupNames(tile);

  // An option already handed in cannot be picked again on a set tile — the
  // server refuses it, so offering it would only produce an error after the
  // upload had already cost the player a round trip. On a points_per_set tile
  // the same call returns only the drops of a group that is already full,
  // since there a repeat is a legitimate submission.
  //
  // Asked on every tile, not only grouped ones: a drop may carry its own
  // `max_times`, and a plain points tile is exactly where that happens.
  const spent = unavailableSetOptionIds(tile, pending);

  const allAssigned = staged.every((s) => {
    if (isValue) {
      const n = millionsToTenths(s.amount);
      return n !== null && n >= MIN_VALUE && n <= MAX_VALUE;
    }
    return !picksDrop || Boolean(s.optionId);
  });

  async function submit() {
    if (willComplete && !(await confirm(
      `This is the last piece of evidence for "${tileName}". Submitting it ` +
      'completes the tile and fires the shot.',
      { title: 'Fire the shot?', confirmLabel: 'Submit & fire' }
    ))) return;

    setBusy(true);
    setError(null);
    try {
      // Sequentially: parallel uploads racing the same locked-in tile is a good way
      // sail past the required count and confuse the person doing it.
      let last = null;
      for (const item of staged) {
        last = await uploadEvidence({
          gameId, teamId, claimId, file: item.file,
          optionId: item.optionId,
          amount: isValue ? millionsToTenths(item.amount) : null,
        });
        // The database fires as soon as this submission completes the rule.
        // Anything after it belongs to a claim that is now closed and would
        // fail with "already fired" after the useful work had succeeded.
        if (last?.fired) break;
      }
      setStaged([]);
      // add_evidence() fires the shot itself once the requirement is met, and
      // says so. `completed` is what the caller falls back on if it did not.
      await onUploaded?.({
        completed: willComplete,
        fired: Boolean(last?.fired),
        result: last?.result ?? null,
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  /** The per-file control: which drop, or how much it was worth. */
  function assign(item, i) {
    if (isValue) {
      // Text rather than number, and deliberately: `type="number"` rejects a
      // decimal comma in most browsers by silently reporting an empty value,
      // so "0,5" would look like nothing was typed at all. Taking the text and
      // parsing it here is what lets both separators work — see
      // lib/millions.js.
      const tenths = millionsToTenths(item.amount);
      const bad = item.amount !== '' && tenths === null;
      return (
        <input
          type="text"
          inputMode="decimal"
          placeholder="Worth, in millions"
          aria-invalid={bad || undefined}
          title={bad ? 'A number in millions — 0.5, 1, 12.5' : undefined}
          value={item.amount}
          disabled={busy}
          onChange={(e) => {
            const amount = e.target.value;
            setStaged((s) => s.map((x, j) => (j === i ? { ...x, amount } : x)));
          }}
        />
      );
    }

    // Grouped when the tile has sets, flat when it does not: an <optgroup> per
    // brother or per boss turns a list of twenty-four into six readable ones,
    // and there is nothing to group by on a plain price list.
    // How many more times this drop may be handed in, or null when it is
    // uncapped. `pending` already counts what is staged, so a cap spends
    // itself as the files are assigned rather than only after the submit.
    const timesLeft = (o) => (o.max_times == null ? null : o.max_times - (
      (o.got ?? (o.taken ? 1 : 0)) + pending.optionIds.filter((id) => id === o.id).length
    ));

    /**
     * What each drop says after its name.
     *
     * A price is named only where it says something — `tileShowsPrices` is the
     * judgement, asked of the whole tile. On a list where every drop is worth
     * the same single point there is nothing to tell apart, and thirty-two
     * rows of "— 1 pt" would be noise standing in for information; on a mixed
     * list every price is worth having, the 1s most of all.
     *
     * A cap is named the same way: only once it is doing something. "4 left"
     * before anything has been submitted is the drop's own small print, and
     * the "?" panel is where small print lives; here it starts mattering when
     * the number begins to fall.
     */
    const note = (o) => {
      if (isSet) return spent.has(o.id) ? ' ✓' : '';

      const price = priced ? ` — ${pointsLabel(o.points)}` : '';
      const left = timesLeft(o);
      if (left === null) return spent.has(o.id) ? `${price} ✓` : price;
      if (left <= 0) return `${price} — used up`;
      if (left < o.max_times) return `${price}, ${left} left`;
      return price;
    };

    const rows = (o) => (
      <option key={o.id} value={o.id} disabled={spent.has(o.id) && o.id !== item.optionId}>
        {o.label}
        {note(o)}
      </option>
    );

    return (
      <select
        value={item.optionId ?? ''}
        disabled={busy}
        onChange={(e) => {
          const optionId = e.target.value || null;
          setStaged((s) => s.map((x, j) => (j === i ? { ...x, optionId } : x)));
        }}
      >
        <option value="">Which drop?</option>
        {next.groups.some((g) => g.named)
          ? next.groups.map((g) => (
              completedGroups.has(g.name)
                ? (
                    <option key={g.name} disabled>
                      {g.name} — ✓ Done
                    </option>
                  )
                : (
                    <optgroup key={g.name} label={g.name}>
                      {g.options.map(rows)}
                    </optgroup>
                  )
            ))
          : options.map(rows)}
      </select>
    );
  }

  return (
    <div className="evidence">
      <p className="evidence-count">
        {now.unit}{' '}
        <strong className={now.done ? 'met' : ''}>
          {now.have} / {now.need}{now.suffix ?? ''}
        </strong>
        {!now.done && stagedPoints > 0 && !grouped && (
          <span className="muted"> (+{stagedPoints} staged)</span>
        )}
        {!now.done && <span className="muted"> — needed before you can fire</span>}
      </p>

      {/* The price list used to sit here, open on the card whenever the tile
          was weighted and nothing was staged. It has moved behind the "?" in
          the tile's header. A slayer tile prices thirty-eight drops, and thirty
          -eight rows of small print pushed the drop zone — the only part of
          this card anyone acts on — off the bottom of a narrow column. The
          prices are still two places away at most: the "?" panel lists them
          all, and the per-file picker below names the points on every option. */}

      {/* Who submitted is recorded on every row and shown on the organiser's
          review screen. It is not repeated here: the count is the only part
          the team acts on, and this card is already tall. */}
      {staged.length > 0 ? (
        <div className="evidence-staged">
          {picksDrop || isValue ? (
            <ul className="evidence-staged-list">
              {staged.map((item, i) => (
                <li key={i}>
                  {/* No filename here on purpose. It is squeezed to a character
                      or two by the card width, tells the player nothing they
                      did not just do, and the control beside it is the only
                      part of this row anyone acts on. */}
                  {assign(item, i)}
                  <button
                    className="ghost"
                    aria-label="Remove"
                    disabled={busy}
                    onClick={() => setStaged((s) => s.filter((_, j) => j !== i))}
                  >
                    &times;
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <span className="evidence-staged-name">
              {staged.length === 1
                ? (staged[0].file.name || 'Screenshot')
                : `${staged.length} screenshots`}
            </span>
          )}
          <div className="row">
            <button className="ghost" onClick={() => setStaged([])} disabled={busy}>
              Remove
            </button>
            <button onClick={submit} disabled={busy || !allAssigned}>
              {busy
                ? (willComplete ? 'Firing…' : 'Submitting…')
                : (willComplete ? 'Submit & fire' : 'Submit')}
            </button>
          </div>
          {!allAssigned && (
            <p className="muted">
              {isValue
                ? 'Type what each drop was worth, in millions — 0.5 and 0,5 both work.'
                : 'Say which drop each screenshot shows before submitting.'}
            </p>
          )}
        </div>
      ) : (
        <div
          className={`evidence-drop${dragging ? ' over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            stage(e.dataTransfer.files);
          }}
        >
          Drop a screenshot, paste, or{' '}
          <button
            type="button"
            className="link"
            onClick={() => { inputRef.current?.click(); }}
          >
            choose a file
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => { stage(e.target.files); e.target.value = ''; }}
          />
        </div>
      )}

      {error && <p className="error">{error}</p>}
      {confirmDialog}
    </div>
  );
});

export default EvidenceUploader;
