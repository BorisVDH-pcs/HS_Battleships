import { useMemo, useState } from 'react';
import { GRID, colLetter, coordLabel, toPosition, fromPosition } from '../lib/board.js';
import {
  newDraft, draftFromRow, payloadFromDraft, payloadFromRow, ruleSummary,
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
}) {
  const [at, setAt] = useState(null);           // { row, col } | null
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const [editing, setEditing] = useState(null); // null | { what, id, draft }

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

  async function place(entry) {
    if (!at) return;
    const position = toPosition(at.row, at.col);
    const ok = await onSetTile(at.row, at.col, payloadFromRow(entry, { libraryId: entry.id }));
    if (ok) setAt(nextEmptyAfter(position));
  }

  async function saveSquare() {
    // The catalogue id rides along only when the square still came from that
    // entry. Editing a square is a local tweak, not an edit of the catalogue.
    const payload = payloadFromDraft(
      editing.draft,
      editing.id ? { libraryId: editing.id } : {}
    );
    if (await onSetTile(at.row, at.col, payload)) setEditing(null);
  }

  async function saveLibrary() {
    const payload = payloadFromDraft(editing.draft, {
      tags: editing.draft.tags.split(',').map((t) => t.trim()).filter(Boolean),
    });
    if (await onSaveLibraryTile(editing.id ?? null, payload)) setEditing(null);
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
                  : editing.id ? 'Edit catalogue tile' : 'New catalogue tile'}
              </h3>
              {/* Three different situations, and the difference matters: a tile
                  placed from the catalogue can be tweaked without touching the
                  entry, a typed one has no entry to touch, and neither reaches
                  the catalogue unless it is put there deliberately. */}
              {editing.what === 'square' && (
                <p className="muted">
                  {editing.id
                    ? <>Changes stay on this board — the catalogue entry it came
                        from is untouched. Use <em>Save to catalogue</em> to keep them.</>
                    : <>This square only. Use <em>Save to catalogue</em> as well if
                        it is worth having on a future board.</>}
                </p>
              )}
              <TileForm
                draft={editing.draft}
                onChange={(draft) => setEditing({ ...editing, draft })}
                at={editing.what === 'square' ? coordLabel(at.row, at.col) : 'This tile'}
                showTags={editing.what === 'library'}
                busy={busy}
                saveLabel={editing.what === 'square' ? 'Save square' : 'Save to catalogue'}
                onSave={editing.what === 'square' ? saveSquare : saveLibrary}
                onCancel={() => setEditing(null)}
                extraActions={editing.what === 'square' ? (
                  <button
                    className="ghost"
                    disabled={busy}
                    onClick={() => onSaveLibraryTile(
                      null, payloadFromDraft(editing.draft, { tags: [] })
                    )}
                  >
                    Save to catalogue
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
                {matches.map((entry) => (
                  <li key={entry.id}>
                    <button
                      className="library-pick"
                      disabled={busy}
                      onClick={() => place(entry)}
                    >
                      <TileIcon slug={entry.icon} fallback={null} />
                      <span className="library-name">{entry.name}</span>
                      <span className="library-rule muted">{ruleSummary(entry)}</span>
                    </button>
                    <button
                      className="ghost library-edit"
                      onClick={() => setEditing({
                        what: 'library', id: entry.id, draft: draftFromRow(entry),
                      })}
                      aria-label={`Edit ${entry.name}`}
                    >
                      Edit
                    </button>
                  </li>
                ))}
              </ul>

              <button
                className="ghost"
                onClick={() => setEditing({
                  what: 'square', id: null, draft: newDraft(),
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
                            what: 'library', id: entry.id, draft: draftFromRow(entry),
                          })}
                        >
                          <TileIcon slug={entry.icon} fallback={null} />
                          <span className="library-name">{entry.name}</span>
                          <span className="library-rule muted">
                            {ruleSummary(entry)}
                            {entry.times_used > 0 && ` · used ${entry.times_used}×`}
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
