import { useMemo, useState } from 'react';
import { GRID, colLetter, coordLabel, toPosition, fromPosition } from '../lib/board.js';
import {
  newDraft, draftFromRow, payloadFromDraft, payloadFromRow, ruleSummary, nameKey,
} from '../lib/tileDraft.js';
import TileIcon from './TileIcon.jsx';
import TileForm from './TileForm.jsx';
import { statusLabel } from '../lib/status.js';

/**
 * Building a board by pointing at it.
 *
 * The paste box came from the spreadsheet: a hundred rows already existed as
 * text, and a form would have been a hundred forms. Three events in, the shape
 * of the job has changed — most squares are a task that has been run before,
 * and the work is choosing rather than typing. So this is the other half of the
 * same feature, not a replacement: the paste box still loads a board that
 * exists as text, and this fills one square at a time from the catalogue.
 *
 * Every click is a write. `admin_set_tile` upserts one square, so a half-built
 * board is a real, resumable thing rather than browser state that a closed tab
 * takes with it — which matters when a hundred squares is an evening of work
 * and two organisers might split it.
 *
 * The catalogue is deliberately not scoped to a game. A tile is a task; which
 * board it lands on this time belongs to the square, not to the task.
 */
export default function BoardBuilder({
  game, tiles, library, libraryError, busy,
  onSetTile, onClearTile, onSaveLibraryTile, onDeleteLibraryTile, onImportBoard,
  onAutofillBoard, onReshuffleBoard, onClearBoard,
}) {
  const [at, setAt] = useState(null);           // { row, col } | null
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  // null | { what: 'square' | 'library', id, from, was, draft }
  //   id   — the catalogue entry the save writes to, null to insert a new one.
  //   from — the entry the draft was seeded from, for the copy this becomes.
  //   was  — square form only: the name the square already had, so that keeping
  //          it is not read as taking a name the catalogue has spoken for.
  const [editing, setEditing] = useState(null);

  const locked = game.status !== 'setup' && game.status !== 'placement';
  const need = game.grid_size * game.grid_size;

  const byPosition = useMemo(
    () => new Map(tiles.map((t) => [t.position, t])),
    [tiles]
  );
  const current = at ? byPosition.get(toPosition(at.row, at.col)) : null;

  const tags = useMemo(() => {
    const all = new Set();
    for (const entry of library) for (const t of entry.tags ?? []) all.add(t);
    return [...all].sort();
  }, [library]);

  /**
   * Where each task already sits on this board, by name.
   *
   * Keyed on the name rather than on `library_id`, because the boards that
   * actually collected duplicates are the pasted ones — `admin_set_tiles`
   * writes no link to the catalogue, so every square on them has a null
   * `library_id` and an id-keyed check would see an empty board. The name is
   * the thing both routes have.
   *
   * The square being edited is left out. Re-picking the tile a square already
   * holds is a no-op, not a clash, and flagging it would make the entry you
   * came here to confirm look like the one thing you may not choose.
   *
   * Autofill needs no part of this: its `pool` already excludes every name the
   * board holds and deals each entry at most once. This is for the two routes
   * that had no check at all — clicking an entry onto a second square, and
   * pasting a hundred lines.
   */
  const placedAt = useMemo(() => {
    const map = new Map();
    for (const t of tiles) {
      if (current && t.position === current.position) continue;
      const key = nameKey(t.name);
      // First wins: on a board that already holds a task twice, naming the
      // earlier square is the more useful half of "it is already somewhere".
      if (!key || map.has(key)) continue;
      const { row, col } = fromPosition(t.position);
      map.set(key, coordLabel(row, col));
    }
    return map;
  }, [tiles, current]);

  const matches = useMemo(() => {
    const words = query.toLowerCase().split(' ').filter(Boolean);
    return library.filter((entry) => {
      if (tag && !(entry.tags ?? []).includes(tag)) return false;
      if (words.length === 0) return true;
      // Drops and tags are searched as well as the name, because the way an
      // organiser remembers a tile is often the loot on it rather than the
      // wording of the task.
      const haystack = [
        entry.name, entry.icon ?? '', entry.description ?? '',
        ...(entry.tags ?? []),
        ...(entry.options ?? []).map((o) => `${o.grp ?? ''} ${o.label}`),
      ].join(' ').toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }, [library, query, tag]);

  /**
   * The catalogue entry this draft would collide with, if any.
   *
   * Names are the catalogue's identity — the unique index is on them — so a
   * copy saved under its original name is refused. That is the right answer,
   * but it arrives after a round trip and reads like a fault. Said here, while
   * the name field is still under the cursor, it reads as the instruction it
   * actually is: give the new one a name of its own.
   *
   * Both forms, not just the catalogue one. The square form has no unique index
   * to run into -- two squares may hold the same tile -- but since a square is
   * filed in the catalogue as it is saved, a name that is spoken for is a worse
   * problem there than a refusal. `saveSquare` matches on the name, so a tile
   * typed under an existing entry's name would be linked to that entry: the
   * square would claim a provenance it does not have, and the entry's use count
   * would be bumped for a tile nobody took from it.
   *
   * For a square the test is whether the name has been *taken*, not whether it
   * is shared -- `editing.was` is the name the square already had, and keeping
   * it is never a clash. Deliberately not `editing.id`, which looks like the
   * same question and is not: a board pasted in and then added to the catalogue
   * has every name catalogued and every `library_id` still null, because
   * neither `admin_set_tiles` nor `admin_import_board_to_library` writes that
   * link. Keyed on the id, this would have refused to save any square on such a
   * board.
   */
  const clash = useMemo(() => {
    if (!editing) return null;
    const key = nameKey(editing.draft.name);
    if (!key) return null;
    if (editing.what === 'square' && key === nameKey(editing.was ?? '')) return null;
    return library.find((e) => e.id !== editing.id && nameKey(e.name) === key) ?? null;
  }, [editing, library]);

  // Two different problems wearing the same error. Clashing with the tile you
  // started from means you have not renamed the copy yet, and the way out is
  // right there in the form; clashing with some third tile means the name is
  // simply spoken for.
  const clashMessage = !clash ? null
    : clash.id === editing?.from?.id
      ? `This is still called "${clash.name}". Give the new tile a name of its own, `
        + `or use "Update ${clash.name} instead" to change that entry.`
      : `The catalogue already has a different tile called "${clash.name}". Pick another name.`;

  /**
   * The catalogue entry that already answers to this draft's name, if any.
   *
   * Saving a square files it in the catalogue too, and "always" has to mean
   * "whenever it is new": the catalogue's identity is its name -- a unique
   * index on it -- and admin_save_library_tile refuses a second entry under a
   * name it already holds. Leaving that entry alone is also the right answer
   * on its own terms, and the one admin_import_board_to_library already takes:
   * an entry may have been tidied, tagged or re-priced since, and one square's
   * copy of it is not the authority on any of that.
   *
   * Keyed on the name alone rather than on the entry the square came from, so
   * renaming a square's tile files the new name as a new entry and leaves the
   * old one standing -- which is what the catalogue form does with a rename
   * too.
   */
  const catalogued = useMemo(() => {
    if (!editing || editing.what !== 'square') return null;
    const key = nameKey(editing.draft.name);
    if (!key) return null;
    return library.find((e) => nameKey(e.name) === key) ?? null;
  }, [editing, library]);

  /**
   * The next square with nothing on it, so filling a board is one click per
   * square rather than two. Starts after the square just filled and wraps;
   * returns null once the board is full, which is what stops the selection
   * jumping somewhere arbitrary at the end.
   */
  function nextEmptyAfter(position) {
    for (let step = 1; step <= need; step += 1) {
      const p = ((position - 1 + step) % need) + 1;
      if (!byPosition.has(p)) return fromPosition(p);
    }
    return null;
  }

  // Every handler below moves on only if the write actually landed. The parent
  // resolves these to a boolean rather than throwing, and a refused save that
  // still closed the form and advanced the selection is indistinguishable from
  // a successful one — which is exactly how a tile goes missing.

  /** Put one tile on the selected square and move to the next empty one. */
  async function placePayload(payload) {
    if (!at) return false;
    const position = toPosition(at.row, at.col);
    const ok = await onSetTile(at.row, at.col, payload);
    if (ok) setAt(nextEmptyAfter(position));
    return ok;
  }

  const place = (entry) =>
    placePayload(payloadFromRow(entry, { libraryId: entry.id }));

  /**
   * Put the tile on the square, and keep it.
   *
   * There used to be a second button for the keeping, and it was the wrong
   * shape: a tile worth typing out is a tile worth having on the next board,
   * and the one press that says so was the one easiest to forget -- so the
   * work of writing a tile was quietly thrown away by default. Now the square
   * and the catalogue are filled by the same press.
   *
   * An entry that already exists is left exactly as it is; see `catalogued`
   * for why. The square still links to it either way, so it knows where its
   * tile came from and the entry's use count keeps counting.
   *
   * Catalogue first, because the square wants the new entry's id. A refused
   * catalogue write stops here with the form still open and the error on it,
   * rather than leaving a square filled from an entry that does not exist.
   */
  async function saveSquare() {
    let libraryId = catalogued?.id ?? null;
    if (!libraryId) {
      // Tags belong to the catalogue and the square form does not show them,
      // so a tile filed this way starts untagged.
      libraryId = await onSaveLibraryTile(
        null, payloadFromDraft(editing.draft, { tags: [] })
      );
      if (!libraryId) return;
    }
    const payload = payloadFromDraft(editing.draft, { libraryId });
    if (await onSetTile(at.row, at.col, payload)) setEditing(null);
  }

  /**
   * Write the catalogue entry, then put it on the square you came from.
   *
   * `targetId` is null for the normal path, which is what makes editing an
   * entry produce a second one: the list hands the form a copy of a tile rather
   * than the tile, so "this task but five screenshots" stops being a choice
   * between the old wording and the new one. Passing the original's id is the
   * deliberate exception, for fixing a typo or adding tags.
   *
   * Placing afterwards is the other half. Editing an entry from the list almost
   * always starts with a square in mind — that is why the square was selected —
   * and having to find the new tile in a catalogue of a hundred and click it
   * again was a step that knew the answer already.
   */
  async function saveLibrary(targetId = editing.id ?? null) {
    const payload = payloadFromDraft(editing.draft, {
      tags: editing.draft.tags.split(',').map((t) => t.trim()).filter(Boolean),
    });
    const id = await onSaveLibraryTile(targetId, payload);
    if (!id) return;
    setEditing(null);
    // Tags belong to the catalogue, not to a board, so the square gets the
    // entry without them — and the id, so the square knows where it came from.
    if (at) await placePayload(payloadFromDraft(editing.draft, { libraryId: id }));
  }

  if (locked) {
    return (
      <section className="card">
        <h2>Board builder</h2>
        <p className="muted">
          Tiles are locked once the game is {statusLabel(game.status)}. Below is
          the board that is running.
        </p>
        <BuilderGrid tiles={byPosition} at={null} onPick={() => {}} />
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Board builder</h2>
      <p className="muted">
        {tiles.length} of {need} squares filled.
        {tiles.length < need && ' Click an empty square, then a tile to put in it.'}
      </p>

      <div className="builder">
        <BuilderGrid
          tiles={byPosition}
          at={at}
          onPick={(row, col) => { setAt({ row, col }); setEditing(null); }}
        />

        <div className="builder-panel">
          {/* Shown in every state of the panel, because the catalogue is what
              all three of them are about. A missing function is named for what
              it almost always is — the migration has not been pushed yet —
              since the raw PostgREST wording sends you looking for a cache
              problem that is not there. */}
          {libraryError && (
            <p className="error">
              The catalogue could not be loaded, so there is nothing to pick
              from. Squares can still be typed in one at a time.
              {libraryError.includes('admin_list_library') && (
                <> This usually means the tile-library migration has not reached
                  the database yet.</>
              )}
              <br />
              <span className="muted">{libraryError}</span>
            </p>
          )}

          {editing ? (
            <>
              <h3>
                {editing.what === 'square'
                  ? `${coordLabel(at.row, at.col)} — ${current ? 'edit this square' : 'a one-off tile'}`
                  : editing.from ? `New tile, based on ${editing.from.name}` : 'New catalogue tile'}
              </h3>
              {/* Two situations now, and only one of them is a decision the
                  press makes: whether the catalogue gains an entry or keeps the
                  one it has. Said before the press rather than after it,
                  because "and it went in the catalogue" is a surprise worth
                  not having. */}
              {editing.what === 'square' && !clash && (
                <p className="muted">
                  {catalogued
                    ? <>Goes on this square. The catalogue already has <b>{catalogued.name}</b>,
                        so that entry is left exactly as it is.</>
                    : <>Goes on this square, and into the catalogue as a new entry
                        so a later board can deal it.</>}
                </p>
              )}
              {editing.what === 'library' && (
                <p className="muted">
                  {editing.from
                    ? <>Saving adds a second entry — <b>{editing.from.name}</b> stays
                        exactly as it is.</>
                    : <>A new entry in the catalogue.</>}
                  {at && <> It goes onto <b>{coordLabel(at.row, at.col)}</b> as well.</>}
                </p>
              )}
              <TileForm
                draft={editing.draft}
                onChange={(draft) => setEditing({ ...editing, draft })}
                at={editing.what === 'square' ? coordLabel(at.row, at.col) : 'This tile'}
                showTags={editing.what === 'library'}
                busy={busy}
                saveLabel={
                  editing.what === 'square' ? 'Save square'
                    : at ? `Save and place on ${coordLabel(at.row, at.col)}`
                      : 'Save to catalogue'
                }
                onSave={editing.what === 'square' ? saveSquare : () => saveLibrary()}
                onCancel={() => setEditing(null)}
                extraErrors={clashMessage ? [clashMessage] : []}
                extraActions={editing.from ? (
                  // The way back to editing in place. Kept because the entries
                  // imported from old boards carry no tags and some carry the
                  // wording of a hurried spreadsheet, and a catalogue you can
                  // only ever add to is one that fills up with near-duplicates.
                  <button
                    className="ghost"
                    disabled={busy}
                    onClick={() => saveLibrary(editing.from.id)}
                  >
                    Update {editing.from.name} instead
                  </button>
                ) : null}
              />
            </>
          ) : at ? (
            <>
              <div className="row builder-head">
                <h3>{coordLabel(at.row, at.col)}</h3>
                <button className="ghost" onClick={() => setAt(null)}>Done</button>
              </div>

              {current ? (
                <div className="builder-current">
                  <div className="builder-current-tile">
                    <TileIcon slug={current.icon} fallback={null} />
                    <div>
                      <b>{current.name}</b>
                      <span className="muted">{ruleSummary(current)}</span>
                      {!current.library_id && (
                        <span className="muted">Typed onto this board only.</span>
                      )}
                    </div>
                  </div>
                  <div className="row">
                    <button
                      className="ghost"
                      onClick={() => setEditing({
                        what: 'square',
                        id: current.library_id,
                        was: current.name,
                        draft: draftFromRow(current),
                      })}
                    >
                      Edit
                    </button>
                    <button
                      className="ghost danger"
                      disabled={busy}
                      onClick={() => onClearTile(at.row, at.col)}
                    >
                      Clear square
                    </button>
                  </div>
                  <p className="muted">Or pick a replacement below.</p>
                </div>
              ) : (
                <p className="muted">Empty. Pick a tile for it.</p>
              )}

              <LibrarySearch
                query={query} setQuery={setQuery}
                tag={tag} setTag={setTag} tags={tags}
                count={matches.length} total={library.length}
              />

              <ul className="library-list">
                {matches.map((entry) => {
                  // Where this task already is, if it is — said, not enforced.
                  //
                  // Putting one tile on several squares is deliberate: a slayer
                  // tile spread across ten of them, or a placeholder standing
                  // in while the board is still being decided. So this reports
                  // and gets out of the way. The one place duplicates are
                  // refused is the shuffle, which excludes every name the board
                  // already holds — a deal that repeated itself would be
                  // filling a board by accident rather than by choice.
                  const already = placedAt.get(nameKey(entry.name));
                  return (
                  <li key={entry.id}>
                    <button
                      className="library-pick"
                      disabled={busy}
                      title={already ? `Already on ${already}` : undefined}
                      onClick={() => place(entry)}
                    >
                      <TileIcon slug={entry.icon} fallback={null} />
                      <span className="library-text">
                        <span className="library-name">{entry.name}</span>
                        <span className="library-rule muted">
                          {ruleSummary(entry)}
                          {already && <span className="library-placed"> · on {already}</span>}
                        </span>
                      </span>
                    </button>
                    <button
                      className="ghost library-edit"
                      onClick={() => setEditing({
                        what: 'library', id: null, from: entry, draft: draftFromRow(entry),
                      })}
                      aria-label={`Edit ${entry.name}`}
                    >
                      Edit
                    </button>
                  </li>
                  );
                })}
              </ul>

              <button
                className="ghost"
                onClick={() => setEditing({
                  what: 'square', id: null, was: '', draft: newDraft(),
                })}
              >
                Type a one-off tile instead
              </button>
            </>
          ) : (
            <>
              <h3>The catalogue</h3>
              <p className="muted">
                {library.length === 0
                  ? 'Empty so far. Import a board that already exists, or add tiles one at a time.'
                  : `${library.length} task${library.length === 1 ? '' : 's'}, most-used first.`}
              </p>

              {/* Deals into the empty squares only, which is what makes it safe
                  to press on a board somebody has already worked on -- and why
                  it needs no confirmation. It is the first draft of a board,
                  not the finished one: the point is to spend the evening on the
                  dozen squares worth arguing about instead of all hundred. */}
              {tiles.length < need && (
                <button
                  disabled={busy || library.length === 0 || Boolean(libraryError)}
                  onClick={onAutofillBoard}
                  title={library.length === 0
                    ? 'The catalogue has no tiles to deal'
                    : undefined}
                >
                  Fill the {need - tiles.length} empty square
                  {need - tiles.length === 1 ? '' : 's'} at random
                </button>
              )}

              {/* The same feature from the other end: deal a board, read it,
                  dislike it, roll again. It sits with the autofill because that
                  is where somebody who has just dealt a board looks, and
                  because on a full board the autofill is gone and this is the
                  only thing here that deals at all.

                  It is the one button in this group that takes something away,
                  so unlike its neighbour it asks first. That is also why it can
                  sit above the additive row without the separator the clear
                  button gets below: a stray press costs a dialog, not a
                  board.

                  In a .row rather than bare in the panel, which is a grid and
                  would stretch it edge to edge. The full width belongs to the
                  autofill above -- the press this panel is built around -- and
                  a second bar the same size reads as a second primary action.
                  Sized to its text, it sits with the other secondary buttons
                  instead. */}
              {tiles.length > 0 && (
                <div className="row">
                  <button
                    className="ghost"
                    disabled={busy || library.length === 0 || Boolean(libraryError)}
                    onClick={onReshuffleBoard}
                    title={library.length === 0
                      ? 'The catalogue has no tiles to deal'
                      : undefined}
                  >
                    Re-randomize the board
                  </button>
                </div>
              )}

              <div className="row">
                {/* Both write to the catalogue, so neither can work while it is
                    unreachable. Offering them would only produce a second copy
                    of the same error. */}
                <button
                  className="ghost"
                  disabled={busy || tiles.length === 0 || Boolean(libraryError)}
                  onClick={onImportBoard}
                  title={tiles.length === 0 ? 'This game has no tiles to import' : undefined}
                >
                  Add this board to the catalogue
                </button>
                <button
                  className="ghost"
                  disabled={Boolean(libraryError)}
                  onClick={() => setEditing({
                    what: 'library', id: null, draft: newDraft(),
                  })}
                >
                  New tile
                </button>
              </div>

              {/* The undo for a board you have decided against -- most often
                  one autofill dealt. Clearing a square at a time is right for a
                  mistake and absurd for a hundred of them. Deliberately down
                  here with nothing beside it, rather than in the row above:
                  every other button on this panel adds something, and a
                  destructive one is the last thing that should sit under a
                  cursor already moving. Hidden on an empty board, where it has
                  nothing to do and would only be a red button to misread. */}
              {tiles.length > 0 && (
                <div className="row builder-clear">
                  <button
                    className="ghost danger"
                    disabled={busy}
                    onClick={onClearBoard}
                  >
                    Remove all {tiles.length} tile{tiles.length === 1 ? '' : 's'}
                  </button>
                </div>
              )}

              {library.length > 0 && (
                <>
                  <LibrarySearch
                    query={query} setQuery={setQuery}
                    tag={tag} setTag={setTag} tags={tags}
                    count={matches.length} total={library.length}
                  />
                  <ul className="library-list">
                    {matches.map((entry) => (
                      <li key={entry.id}>
                        <button
                          className="library-pick"
                          onClick={() => setEditing({
                            what: 'library', id: null, from: entry, draft: draftFromRow(entry),
                          })}
                        >
                          <TileIcon slug={entry.icon} fallback={null} />
                          <span className="library-text">
                            <span className="library-name">{entry.name}</span>
                            {/* The use count used to sit here. It is the least
                                useful thing on the row and it was taking its
                                width from the name, which is the whole reason
                                you are reading the row at all. */}
                            <span className="library-rule muted">{ruleSummary(entry)}</span>
                          </span>
                        </button>
                        <button
                          className="ghost library-edit danger"
                          disabled={busy}
                          onClick={() => onDeleteLibraryTile(entry)}
                          aria-label={`Delete ${entry.name}`}
                        >
                          Delete
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function LibrarySearch({ query, setQuery, tag, setTag, tags, count, total }) {
  return (
    <div className="library-search">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search the catalogue"
      />
      {tags.length > 0 && (
        <select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Filter by tag">
          <option value="">All tags</option>
          {tags.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      )}
      {count !== total && <span className="muted">{count} of {total}</span>}
    </div>
  );
}

/**
 * The board, as something to point at.
 *
 * Deliberately not TileBoard: that one is for proofreading a finished board and
 * sizes a square to fit a hundred of them on a page. Here a square is a target,
 * so it is a real button with a pressed state, and an empty one reads as an
 * invitation rather than as the error TileBoard correctly calls it.
 */
function BuilderGrid({ tiles, at, onPick }) {
  return (
    <div className="tile-board-wrap">
      <div className="tile-board builder-board">
        <div className="corner" />
        {Array.from({ length: GRID }, (_, i) => (
          <div key={`h${i}`} className="axis">{colLetter(i + 1)}</div>
        ))}
        {Array.from({ length: GRID }, (_, r) => {
          const row = r + 1;
          return [
            <div key={`a${row}`} className="axis">{row}</div>,
            ...Array.from({ length: GRID }, (_, c) => {
              const col = c + 1;
              const tile = tiles.get(toPosition(row, col));
              const here = at && at.row === row && at.col === col;
              return (
                <button
                  key={`${row}-${col}`}
                  type="button"
                  className={`tile-cell builder-cell${tile ? '' : ' empty'}${here ? ' on' : ''}`}
                  onClick={() => onPick(row, col)}
                  title={tile ? tile.name : `${coordLabel(row, col)} — empty`}
                >
                  <b>{coordLabel(row, col)}</b>
                  {tile?.icon && <TileIcon slug={tile.icon} fallback={null} />}
                  <span>{tile?.name ?? ''}</span>
                </button>
              );
            }),
          ];
        })}
      </div>
    </div>
  );
}
