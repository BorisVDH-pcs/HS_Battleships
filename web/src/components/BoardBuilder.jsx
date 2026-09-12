import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GRID, colLetter, coordLabel, toPosition, fromPosition } from '../lib/board.js';
import {
  newDraft, draftFromRow, payloadFromDraft, payloadFromRow, ruleSummary, nameKey,
} from '../lib/tileDraft.js';
import TileIcon from './TileIcon.jsx';
import TileInfo from './TileInfo.jsx';
import TileForm from './TileForm.jsx';
import { statusLabel } from '../lib/status.js';
import {
  tileGroups, replayTile, unavailableSetOptionIds, completedEachSetGroupNames,
  tileShowsPrices, pointsLabel,
} from '../lib/tileProgress.js';
import { adminTestTile, adminListBoardPresets } from '../lib/supabase.js';

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
  onSetTile, onClearTile, onSaveLibraryTile, onDeleteLibraryTile,
  onAutofillBoard, onReshuffleBoard, onClearBoard,
  onSaveBoard, onLoadBoard, onDeleteBoard,
}) {
  // Saved boards. Held here rather than in the console's own slices because
  // nothing outside this panel reads them, and re-fetching a list of names
  // after a save is cheaper than teaching the refresh machinery a sixth slice.
  const [presets, setPresets] = useState([]);
  const [presetId, setPresetId] = useState('');
  const [saveName, setSaveName] = useState('');

  const reloadPresets = useCallback(async () => {
    try {
      setPresets(await adminListBoardPresets());
    } catch {
      // A board that cannot list its saves is still a board worth building;
      // the failure surfaces the moment anything is actually pressed.
      setPresets([]);
    }
  }, []);

  useEffect(() => { reloadPresets(); }, [reloadPresets]);
  const [at, setAt] = useState(null);           // { row, col } | null
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  // Show the board the way a team will see it once they lock a square in:
  // artwork only, no captions. Off by default — the names are what you build
  // with, this is what you check with.
  const [playerView, setPlayerView] = useState(false);
  // null | { what: 'square' | 'library', id, from, was, draft }
  //   id   — the catalogue entry the save writes to, null to insert a new one.
  //   from — the entry the draft was seeded from, for the copy this becomes.
  //   was  — square form only: the name the square already had, so that keeping
  //          it is not read as taking a name the catalogue has spoken for.
  const [editing, setEditing] = useState(null);

  // Three states, not two.
  //
  //   before  — setup/placement: the whole board is yours, and so are the
  //             board-level tools that deal, clear and load one.
  //   live    — active: a square nobody has locked in can still be fixed, which
  //             is what makes a wrong drop list spotted in the second hour
  //             something other than permanent. A claimed square cannot: the
  //             database refuses it, and would silently reset a set tile's
  //             collected evidence if it did not (see 20260913010000).
  //             Whole-board tools are gone here — every one of them is refused
  //             mid-game, and offering a button that cannot work is worse than
  //             not offering it.
  //   after   — finished: nothing to fix, and rewriting a tile would only make
  //             the record of the match lie.
  const live = game.status === 'active';
  const locked = !live && game.status !== 'setup' && game.status !== 'placement';
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

  // What the random deal is allowed to draw from — the same label a board is
  // built from by hand, so "only raids" means the same thing to both. Ignores
  // the text search: a stray word left in that box would otherwise silently
  // block a deal that has nothing to do with it.
  const tagPool = useMemo(
    () => (tag ? library.filter((e) => (e.tags ?? []).includes(tag)) : library),
    [library, tag]
  );

  /**
   * Where each task already sits on this board, by name.
   *
   * Keyed on the name rather than on `library_id` so that even an older board
   * whose squares predate the catalogue link still gets a useful answer here.
   *
   * The square being edited is left out. Re-picking the tile a square already
   * holds is a no-op, not a clash, and flagging it would make the entry you
   * came here to confirm look like the one thing you may not choose.
   *
   * Autofill needs no part of this: its `pool` already excludes every name the
   * board holds and deals each entry at most once. This is for the one route
   * that has no check of its own — clicking an entry onto a second square.
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

  /**
   * The artwork, which is the whole of what a player sees.
   *
   * Once a team locks a square in, the name goes onto the card in the side
   * column and the board itself shows the icon and nothing else. Two squares
   * carrying the same picture are therefore two squares a team cannot tell
   * apart at a glance on the board they spend the event looking at — and it is
   * invisible here, where every cell is captioned with its name.
   *
   * Not an error. A hundred squares against the icons that exist will repeat,
   * and repeating a boss across two of its drops is reasonable. It is worth
   * seeing before an event rather than hearing about during one.
   */
  const artwork = useMemo(() => {
    const uses = new Map();
    for (const t of tiles) if (t.icon) uses.set(t.icon, (uses.get(t.icon) ?? 0) + 1);
    const shared = new Set([...uses].filter(([, n]) => n > 1).map(([slug]) => slug));
    return {
      missing: tiles.filter((t) => !t.icon).length,
      sharedSquares: tiles.filter((t) => t.icon && shared.has(t.icon)).length,
    };
  }, [tiles]);

  /**
   * The catalogue, filtered and then ordered by how well it answers.
   *
   * Filtering searches drops and tags as well as the name, because the way an
   * organiser remembers a tile is often the loot on it rather than the wording
   * of the task. That is what makes the ordering necessary: a search for a
   * tile by name would return it alongside every tile that merely lists the
   * same drop, in the catalogue's own most-used-first order, so the one you
   * typed the name of could sit anywhere in forty rows.
   *
   * Four tiers, name first — an exact name, then a name that starts with what
   * was typed, then one that contains it, then everything matched only by its
   * drops, tags or description.
   *
   * The sort is stable, so within a tier the catalogue's most-used-first order
   * survives untouched. That matters more than it looks: most-used-first is
   * itself a useful ranking, and this only overrides it where the name says
   * something stronger.
   */
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const words = q.split(' ').filter(Boolean);

    const scored = [];
    for (const entry of library) {
      if (tag && !(entry.tags ?? []).includes(tag)) continue;
      if (words.length === 0) { scored.push({ entry, rank: 0 }); continue; }

      const haystack = [
        entry.name, entry.icon ?? '', entry.description ?? '',
        ...(entry.tags ?? []),
        ...(entry.options ?? []).map((o) => `${o.grp ?? ''} ${o.label}`),
      ].join(' ').toLowerCase();
      if (!words.every((word) => haystack.includes(word))) continue;

      // Ranked on the whole query against the name, not word by word: "raids
      // purples" should favour the tile called that over one whose drop list
      // happens to contain both words apart.
      const name = (entry.name ?? '').toLowerCase();
      const rank = name === q ? 0
        : name.startsWith(q) ? 1
          : name.includes(q) ? 2
            : 3;
      scored.push({ entry, rank });
    }

    return scored.sort((a, b) => a.rank - b.rank).map((s) => s.entry);
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
   * same question and is not: a brand-new one-off tile has `editing.id` null
   * regardless of whether its name is already catalogued, so an id-keyed check
   * would misread "this name is taken" as "nothing to compare against".
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

  /**
   * The last square changed, and what was on it before.
   *
   * Every click here is a write, which is what makes a half-built board a real
   * resumable thing rather than browser state — and also what makes a misclick
   * permanent. The way back was Clear square then find the tile again and place
   * it, which is a lot of work to undo one press, and impossible if you have
   * already forgotten what was there.
   *
   * One level deep on purpose. The mistake this catches is the one you have
   * just noticed; a stack would invite treating the board as editable history,
   * which it is not — the writes are already in the database and another
   * organiser may be filling squares at the same time.
   *
   * Cleared by the bulk actions below. Offering "undo J10" after "remove every
   * tile" would restore one square into a board that no longer exists.
   */
  const [undo, setUndo] = useState(null);   // { row, col, label, prev } | null

  function remember(row, col) {
    setUndo({
      row, col,
      label: coordLabel(row, col),
      prev: byPosition.get(toPosition(row, col)) ?? null,
    });
  }

  async function undoLast() {
    if (!undo) return;
    const { row, col, prev } = undo;
    // Restoring is the same write as placing, so it goes through the same
    // guard: a refused restore leaves the offer standing rather than claiming
    // to have put something back.
    const ok = prev
      ? await onSetTile(row, col, payloadFromRow(prev, { libraryId: prev.library_id }))
      : await onClearTile(row, col);
    if (ok) { setUndo(null); setAt({ row, col }); }
  }

  // Every handler below moves on only if the write actually landed. The parent
  // resolves these to a boolean rather than throwing, and a refused save that
  // still closed the form and advanced the selection is indistinguishable from
  // a successful one — which is exactly how a tile goes missing.

  /** Put one tile on the selected square and move to the next empty one. */
  async function placePayload(payload) {
    if (!at) return false;
    const position = toPosition(at.row, at.col);
    remember(at.row, at.col);
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
    remember(at.row, at.col);
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
        {live ? (
          <>
            The game is running. A square no team has locked in can still be
            fixed; a claimed one is marked and cannot be changed.
          </>
        ) : (
          <>
            {tiles.length} of {need} squares filled.
            {tiles.length < need && ' Click an empty square, then a tile to put in it.'}
            {' Arrow keys move around the board; Enter opens the square.'}
          </>
        )}
      </p>

      {tiles.length > 0 && (
        <p className="builder-view-toggle">
          <button className="ghost" onClick={() => setPlayerView((v) => !v)}>
            {playerView ? 'Back to names' : 'See it as a player does'}
          </button>
          {playerView && (
            <span className="muted">
              Artwork only — what a team sees once they lock a square in.
              {artwork.sharedSquares > 0 && (
                <> <b>{artwork.sharedSquares}</b> squares share a picture with
                  another.</>
              )}
              {artwork.missing > 0 && (
                <> <b>{artwork.missing}</b> have no artwork and fall back to the
                  stand-in.</>
              )}
              {artwork.sharedSquares === 0 && artwork.missing === 0
                && ' Every square has its own picture.'}
            </span>
          )}
        </p>
      )}

      {/* Above the board rather than in the panel, because the panel changes
          shape three ways and the offer must not move or vanish with it. It
          says what it will put back, since "Undo" alone cannot be told apart
          from "undo the whole board". */}
      {undo && (
        <p className="builder-undo">
          <button className="ghost" disabled={busy} onClick={undoLast}>
            Undo {undo.label}
          </button>
          <span className="muted">
            {undo.prev
              ? <>Puts <b>{undo.prev.name}</b> back on {undo.label}.</>
              : <>Empties {undo.label} again.</>}
          </span>
        </p>
      )}

      <div className="builder">
        <BuilderGrid
          tiles={byPosition}
          live={live}
          playerView={playerView}
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
          ) : at && playerView ? (
            // Keyed per square AND per tile, so moving to another square starts
            // a fresh test session rather than inheriting the last one. Without
            // it React reuses this instance and the simulated row it is holding
            // — which showed H1 a set belonging to the tile tested before it.
            // Editing the tile in place counts as a new session too: the drops
            // may be different ones.
            <PlayerSquarePreview
              key={`${at.row}-${at.col}-${current?.id ?? 'empty'}`}
              at={at}
              tile={current}
              onClose={() => setAt(null)}
            />
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

                  {/* The one thing this square cannot do, said before the
                      buttons rather than after a refused save. Both kinds of
                      claim count: a fired one means a team has already played
                      this square, and rewriting it would rewrite what they
                      played. */}
                  {live && current.claimed && (
                    <p className="muted">
                      A team has locked this square in, so it cannot be changed
                      while the game runs. Release the claim on the Track tab if
                      it really has to move.
                    </p>
                  )}

                  <div className="row">
                    <button
                      className="ghost"
                      disabled={live && current.claimed}
                      onClick={() => setEditing({
                        what: 'square',
                        id: current.library_id,
                        was: current.name,
                        draft: draftFromRow(current),
                      })}
                    >
                      Edit
                    </button>
                    {/* Emptying a square is refused for the whole of a live
                        game, claimed or not: `start_game` requires exactly
                        grid_size² tiles, so a hole in a running board is a
                        square the grid draws and nobody can ever claim. */}
                    {!live && (
                      <button
                        className="ghost danger"
                        disabled={busy}
                        onClick={() => { remember(at.row, at.col); onClearTile(at.row, at.col); }}
                      >
                        Clear square
                      </button>
                    )}
                  </div>
                  {!(live && current.claimed) && (
                    <p className="muted">Or pick a replacement below.</p>
                  )}
                </div>
              ) : (
                <p className="muted">Empty. Pick a tile for it.</p>
              )}

              {!(live && current?.claimed) && (
                <LibrarySearch
                  query={query} setQuery={setQuery}
                  tag={tag} setTag={setTag} tags={tags}
                  count={matches.length} total={library.length}
                />
              )}

              <ul className="library-list" hidden={live && current?.claimed}>
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
                hidden={live && current?.claimed}
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
                {live
                  ? 'Pick a square to fix it. Dealing, clearing and loading a '
                    + 'whole board are for before the game starts.'
                  : library.length === 0
                    ? 'Empty so far. Import a board that already exists, or add tiles one at a time.'
                    : `${library.length} task${library.length === 1 ? '' : 's'}, most-used first.`}
              </p>

              {/* Saved boards.

                  A board is an evening's work and, until this existed, a thing
                  that lived in one place with "Remove all 100 tiles" beneath
                  it. Nothing could rebuild one either: the random deal cannot
                  repeat a tile, so a board that uses eighteen squares on four
                  repeated tiles is not something any amount of re-dealing will
                  produce again.

                  Above the deal buttons because it outranks them: the first
                  question on a fresh board is "do I already have one", and the
                  answer being yes makes everything below it unnecessary. */}
              <div className="builder-presets" hidden={live}>
                <h4>Saved boards</h4>

                {presets.length > 0 && (
                  <div className="row">
                    <select
                      value={presetId}
                      onChange={(e) => setPresetId(e.target.value)}
                      aria-label="Saved board"
                    >
                      <option value="">Choose a saved board…</option>
                      {presets.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} — {p.squares} square{p.squares === 1 ? '' : 's'}
                          {p.grid_size !== GRID ? ` (${p.grid_size}×${p.grid_size})` : ''}
                        </option>
                      ))}
                    </select>
                    <button
                      disabled={busy || !presetId}
                      onClick={async () => {
                        const preset = presets.find((p) => p.id === presetId);
                        setUndo(null);
                        await onLoadBoard(preset);
                      }}
                    >
                      Load
                    </button>
                    <button
                      className="ghost danger"
                      disabled={busy || !presetId}
                      onClick={async () => {
                        const preset = presets.find((p) => p.id === presetId);
                        if (await onDeleteBoard(preset)) {
                          setPresetId('');
                          await reloadPresets();
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>
                )}

                {/* Saving is offered only when there is something to save, and
                    an existing name overwrites rather than making "V4 (2)" —
                    which is what makes this usable as a running save while a
                    board is being built, rather than a thing you do once. */}
                {tiles.length > 0 && (
                  <div className="row">
                    <input
                      value={saveName}
                      onChange={(e) => setSaveName(e.target.value)}
                      placeholder="Name this board"
                      maxLength={80}
                    />
                    <button
                      className="ghost"
                      disabled={busy || !saveName.trim()}
                      onClick={async () => {
                        const name = saveName.trim();
                        const existing = presets.find(
                          (p) => p.name.trim().toLowerCase() === name.toLowerCase()
                        );
                        if (await onSaveBoard(name, existing)) {
                          setSaveName('');
                          await reloadPresets();
                        }
                      }}
                    >
                      Save these {tiles.length} square{tiles.length === 1 ? '' : 's'}
                    </button>
                  </div>
                )}

                {presets.length === 0 && tiles.length === 0 && (
                  <p className="muted">
                    No saved boards yet. Build one and it can be kept here.
                  </p>
                )}
              </div>

              {/* The label the random deal draws from — a subset of the
                  catalogue for this game, same as the tag filter on the list
                  below does for picking by hand. Shown above the two deal
                  buttons so it reads as scoping them, not as part of the
                  browse list further down. All labels by default, which deals
                  from the whole catalogue exactly as before this existed. */}
              {!live && tags.length > 0 && (
                <label className="field builder-deal-tag">
                  <span>Deal only tiles labelled</span>
                  <select value={tag} onChange={(e) => setTag(e.target.value)}>
                    <option value="">All labels</option>
                    {tags.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
              )}

              {/* Deals into the empty squares only, which is what makes it safe
                  to press on a board somebody has already worked on -- and why
                  it needs no confirmation. It is the first draft of a board,
                  not the finished one: the point is to spend the evening on the
                  dozen squares worth arguing about instead of all hundred. */}
              {!live && tiles.length < need && (
                <button
                  disabled={busy || tagPool.length === 0 || Boolean(libraryError)}
                  onClick={() => { setUndo(null); onAutofillBoard(tag); }}
                  title={tagPool.length === 0
                    ? (tag ? `No tiles are labelled "${tag}"` : 'The catalogue has no tiles to deal')
                    : undefined}
                >
                  Fill the {need - tiles.length} empty square
                  {need - tiles.length === 1 ? '' : 's'} at random
                  {tag && ` from "${tag}"`}
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
              {!live && tiles.length > 0 && (
                <div className="row">
                  <button
                    className="ghost"
                    disabled={busy || tagPool.length === 0 || Boolean(libraryError)}
                    onClick={() => { setUndo(null); onReshuffleBoard(tag); }}
                    title={tagPool.length === 0
                      ? (tag ? `No tiles are labelled "${tag}"` : 'The catalogue has no tiles to deal')
                      : undefined}
                  >
                    Re-randomize the board
                    {tag && ` from "${tag}"`}
                  </button>
                </div>
              )}

              <div className="row">
                {/* The paste box now files every name it does not already
                    recognise, the same way a square typed here does -- so
                    this is the only way left to add a tile with no square in
                    mind yet. Disabled on the same terms as everything else
                    that writes to the catalogue. */}
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
              {!live && tiles.length > 0 && (
                <div className="row builder-clear">
                  <button
                    className="ghost danger"
                    disabled={busy}
                    onClick={() => { setUndo(null); onClearBoard(); }}
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

/**
 * What this square becomes once a team locks it in — the same card and the
 * same working "?" info panel as Active tiles, so a description or a price
 * list can be checked here rather than found missing mid-event.
 *
 * Read-only on purpose: player view is a check, not an editing mode, so no
 * Edit or Clear button rides along with it. `TileInfo` already renders
 * nothing for a tile with no small print and no priced drops — the same
 * absence a player would see — so this needs no extra case for that.
 */
function PlayerSquarePreview({ at, tile, onClose }) {
  const label = coordLabel(at.row, at.col);

  // The test session lives here rather than inside the uploader, because a
  // player's card, "?" panel and picker are all drawn from ONE `tiles_for_me`
  // row and move together as evidence lands. Holding the simulated row at the
  // level all three can see is what reproduces that: tick a drop off in the
  // panel and it closes in the picker, because they are the same object.
  const [session, setSession] = useState(null);

  // The id check is a belt beside the braces. The `key` on this component is
  // what actually starts a fresh session per square; this makes a stale one
  // harmless rather than wrong, because the failure it guards against is
  // silent and convincing — a real drop list, correctly drawn, belonging to
  // the wrong tile.
  const shown = session?.state?.id === tile?.id ? session.state : tile;

  return (
    <>
      <div className="row builder-head">
        <h3>{label}</h3>
        <button className="ghost" onClick={onClose}>Done</button>
      </div>
      {tile ? (
        <article className="slot filled">
          <div className="slot-art">
            <TileIcon
              slug={tile.icon}
              standIn
              fallback={<span className="slot-art-coord">{label}</span>}
            />
          </div>
          <div className="slot-head">
            <strong>{tile.name}</strong>
            {/* The simulated row, so the price list fills in its ticks and its
                per-set counters as the test session goes on — the same panel
                the player would be reading at that point in the tile. */}
            <TileInfo tile={shown} />
            <span className="coord">{label}</span>
          </div>
          <EvidencePreview key={tile.id} tile={tile} shown={shown} onSession={setSession} />
        </article>
      ) : (
        <p className="muted">Empty. A player sees nothing here yet.</p>
      )}
    </>
  );
}

/**
 * The one part of submitting evidence that differs from tile to tile: what a
 * screenshot has to say beyond itself. `EvidenceUploader` asks this only once
 * a file is staged, which a preview with nothing to upload never reaches — so
 * this shows the same control up front instead, disabled, for reading rather
 * than for use.
 *
 * A plain screenshot tile — no options, not priced by value — asks nothing
 * beyond the image, so there is no control to show and this renders nothing,
 * the same way the real uploader's per-file picker never appears for one.
 *
 * Grouped through the same `tileGroups` the live picker and the "?" panel
 * both use, so a set tile's dropdown here has exactly the optgroups a player
 * would get — nothing here is a second copy of that logic to drift from it.
 *
 * Open, not disabled: a disabled `<select>` cannot be opened at all in most
 * browsers, which hides the very thing this exists to show — whether the
 * full list of options is actually in there. So it is a real, pickable
 * control with nowhere to send what gets picked; there is no submit button
 * beside it and the choice lives only in this component's own state, gone
 * the moment a different square is selected.
 */
function EvidencePreview({ tile, shown = tile, onSession }) {
  const options = tile.options ?? [];
  const rule = tile.completion ?? 'points';
  const isSet = rule === 'one_set' || rule === 'each_set';
  const isValue = rule === 'value';
  const [value, setValue] = useState('');
  const [picks, setPicks] = useState([]);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // A plain screenshot tile has nothing to pick, but it can still be tested —
  // "does five screenshots finish it" is a real question with a real answer,
  // and it is the one shape where the target and the count are the same
  // number, which is exactly where an off-by-one hides.
  const picksNothing = !isValue && options.length === 0;

  const label = (id) => options.find((o) => o.id === id)?.label ?? 'Screenshot';

  /**
   * Submit one more screenshot and see what it did.
   *
   * The whole session is replayed server-side on every press rather than kept
   * open between them. A claim that stayed alive across presses would be a
   * real row on a real board waiting for someone to close the browser on it;
   * this way each press is its own transaction, rolled back before it returns,
   * and the tester holds the only state there is — the list of what has been
   * submitted so far.
   */
  async function submit(pick) {
    const next = [...picks, pick];
    setPicks(next);
    setBusy(true);
    setError(null);
    try {
      const server = await adminTestTile(tile.id, next.map((p) => ({
        ...(p.optionId ? { option_id: p.optionId } : {}),
        ...(p.amount ? { amount: Number(p.amount) } : {}),
      })));
      const client = replayTile(tile, next);
      setResult({ server, client });
      // Hand the simulated row up, so the "?" panel beside the tile's name
      // shows what the player would be reading at this point in the session.
      onSession?.(client);
      // A drop that has just closed cannot stay selected: the real picker
      // would have disabled it, and leaving it there invites a second press
      // that only earns a refusal.
      if (pick.optionId && unavailableSetOptionIds(client.state).has(pick.optionId)) {
        setValue('');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Matching EvidenceUploader's own rule for when a price is worth printing,
  // since the whole purpose of this preview is to show what the player sees:
  // set rules never price, and a points_per_set tile prices in ones, where
  // thirty-odd "— 1 pts" would be noise standing in for information.
  // The same judgement the real picker makes, through the same function: a
  // price is printed only where the tile's prices differ from one another.
  const priced = tileShowsPrices(tile);

  // What the real picker would refuse by now, asked of the SIMULATED row and
  // through the same two functions EvidenceUploader asks. This preview used to
  // offer every drop unconditionally, which made it more permissive than the
  // interface it was previewing: on H2 you could pick a third Bandos hilt into
  // a General Graardor that was already finished, and watch the tile not move.
  // The player's own card has never allowed that.
  const spent = unavailableSetOptionIds(shown);
  const doneGroups = completedEachSetGroupNames(shown);

  const rows = (o) => (
    <option key={o.id} value={o.id} disabled={spent.has(o.id)}>
      {o.label}{!isSet && priced ? ` — ${pointsLabel(o.points)}` : ''}
      {spent.has(o.id) ? ' ✓' : ''}
    </option>
  );
  const groups = tileGroups(shown.options ?? options);

  return (
    <div className="evidence">
      <p className="evidence-count muted">
        {picksNothing
          ? 'This tile asks for nothing but the screenshot. Submit a few and watch it.'
          : 'Pick a drop and submit it, as a player would. Nothing here is saved.'}
      </p>
      {isValue && (
        <input
          type="number"
          min="1"
          max="1000"
          placeholder="Worth, in millions"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      )}
      {/* A plain screenshot tile has no control here, exactly as the real
          uploader shows none — but it still gets the tester below, since
          "how many screenshots finish this" is a question worth asking. */}
      {!isValue && !picksNothing && (
        <select value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">Which drop?</option>
          {/* A finished set collapses to one disabled line, exactly as the
              real picker collapses it — the drops inside it are not choices
              any more, and listing them greyed out just makes the list long. */}
          {groups.some((g) => g.named)
            ? groups.map((g) => (
                doneGroups.has(g.name)
                  ? <option key={g.name} disabled>{g.name} — ✓ Done</option>
                  : <optgroup key={g.name} label={g.name}>{g.options.map(rows)}</optgroup>
              ))
            : (shown.options ?? options).map(rows)}
        </select>
      )}

      <TileTester
        picks={picks}
        onSubmit={() => {
          if (isValue) {
            if (value) { submit({ amount: value }); setValue(''); }
          } else if (picksNothing) {
            submit({});
          } else if (value) {
            submit({ optionId: value });
          }
        }}
        canSubmit={picksNothing || Boolean(value)}
        label={label}
        busy={busy}
        result={result}
        error={error}
        onReset={() => {
          setPicks([]); setResult(null); setError(null); setValue('');
          onSession?.(null);
        }}
      />
    </div>
  );
}

/**
 * Playing the tile, one screenshot at a time.
 *
 * A tile's rule only says what it means once evidence starts arriving, and the
 * only way to find out used to be to put the square in front of a team — by
 * which point the board is locked.
 *
 * It reads as a play session rather than as a test harness on purpose. The
 * first cut staged a batch and checked it in one go, which answered the
 * question but asked the reader to think in lists: pick, Add, pick, Add, Test.
 * A player does not experience a tile that way. They submit one thing, see the
 * counter move, and submit the next — and the thing worth checking is exactly
 * that experience, including which submission is the one that fires the shot
 * and what the refusal says when a drop has run out.
 *
 * TWO ANSWERS, DELIBERATELY. `admin_test_tile` replays the session through the
 * real `claim_is_complete()` in a transaction it rolls back; `replayTile` runs
 * the same list through `tileProgress.js`. The database is the authority — but
 * the browser's copy of the rules is what draws the player's counter and
 * decides when their button says "Submit & fire", and the two drifting apart
 * is the failure this repo has been one careless edit away from since 0049.
 * When they disagree, that is the headline and nothing else matters.
 */
function TileTester({ picks, onSubmit, canSubmit, label, busy, result, error, onReset }) {
  const server = result?.server;
  const done = Boolean(server?.complete);
  const agree = result && server.complete === result.client.complete;

  // What the last press did — the only part of the answer that is news. The
  // rest of the history is on the list below it.
  const last = server?.steps?.[server.steps.length - 1];

  // The counter in the player's own words, from the player's own module, so
  // this cannot read differently from the card it is predicting.
  const progress = result?.client.progress;

  return (
    <div className="tile-tester">
      <div className="row">
        <button type="button" onClick={onSubmit} disabled={!canSubmit || busy || done}>
          {busy ? 'Submitting…' : 'Test submit'}
        </button>
        {picks.length > 0 && (
          <button type="button" className="ghost" onClick={onReset} disabled={busy}>
            Start over
          </button>
        )}
        {picks.length > 0 && (
          <span className="muted">{picks.length} submitted</span>
        )}
      </div>

      {error && <p className="error">{error}</p>}
      {server?.error && (
        <p className="error">The database could not run the test: {server.error}</p>
      )}

      {result && !server.error && (
        <div className="tile-tester-result">
          {/* The card's own counter line, drawn the way the card draws it. */}
          {progress && (
            <p className="evidence-count">
              {progress.unit}{' '}
              <strong className={progress.done ? 'met' : ''}>
                {progress.have} / {progress.need}{progress.suffix ?? ''}
              </strong>
            </p>
          )}

          {last?.refused ? (
            <p className="error">Refused: {last.refused}</p>
          ) : done && last?.n === server.completed_at_step ? (
            // The press that fired it. Said in the words the player's own
            // confirmation uses, since that is the moment being rehearsed.
            <p className="met"><strong>Submit &amp; fire</strong> — that shot goes off.</p>
          ) : (
            <p className="muted">
              Accepted{last && last.awarded > 0
                ? ` — worth ${last.awarded}${server.rule === 'value'
                    ? 'm'
                    : ` pt${last.awarded === 1 ? '' : 's'}`}`
                : ''}.
            </p>
          )}

          {done && (
            <p className="muted">
              Fired on submission {server.completed_at_step} of {picks.length}
              {server.accepted < picks.length
                && ` · ${picks.length - server.accepted} turned away`}
              . Start over to try another route.
            </p>
          )}

          {!agree && (
            // The whole reason both answers are computed. If this ever shows,
            // tileProgress.js and claim_is_complete() have parted company and
            // the player's card is lying to them in one direction or the other.
            <p className="error">
              The browser disagrees with the database: it makes this{' '}
              {result.client.complete ? 'finished' : 'unfinished'}. The card
              would mislead the player — one of the two rule copies needs fixing.
            </p>
          )}

          {picks.length > 0 && (
            <ol className="tile-tester-picks">
              {picks.map((p, i) => {
                const step = server.steps?.[i];
                return (
                  <li key={i} className={step?.refused ? 'refused' : undefined}>
                    <span>{p.amount ? `${p.amount}m` : label(p.optionId)}</span>
                    {step?.refused
                      ? <em className="muted">turned away</em>
                      : step?.n === server.completed_at_step
                        ? <em className="met">fired</em>
                        : null}
                  </li>
                );
              })}
            </ol>
          )}

          <p className="muted">Nothing was saved: no claim, no evidence, no shot.</p>
        </div>
      )}
    </div>
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
function BuilderGrid({ tiles, at, onPick, playerView = false, live = false }) {
  const gridRef = useRef(null);
  // Which cell the Tab key lands on — a roving tabindex, so the board is one
  // stop on the way through the page rather than a hundred. Without it,
  // reaching the panel beside the board means pressing Tab a hundred times.
  const [focusPos, setFocusPos] = useState(1);

  // Follows a square chosen any other way — a click, or the auto-advance to
  // the next empty square after a placement — so the keyboard picks up from
  // wherever the board actually is rather than from where it last was.
  useEffect(() => {
    if (at) setFocusPos(toPosition(at.row, at.col));
  }, [at]);

  /**
   * Arrows move, Home/End jump to the ends of a row.
   *
   * Selecting as it moves, rather than only on Enter: the panel beside the
   * board is what a square means, and a selection that lagged behind the
   * focus ring would leave the two describing different squares. Enter and
   * Space still work — they are a button's own, and land on the square the
   * ring is already on.
   *
   * Focus is moved after the state, since the cell being focused only becomes
   * tabbable once `focusPos` has been through a render.
   */
  function onKeyDown(e) {
    const moves = {
      ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
    };
    const from = fromPosition(focusPos);
    let row = from.row;
    let col = from.col;

    if (moves[e.key]) {
      row += moves[e.key][0];
      col += moves[e.key][1];
    } else if (e.key === 'Home') {
      col = 1;
    } else if (e.key === 'End') {
      col = GRID;
    } else {
      return;
    }

    // Clamped rather than wrapped. Wrapping off the end of row 3 into row 4
    // reads as a jump on a grid whose whole point is that position means
    // something.
    row = Math.min(GRID, Math.max(1, row));
    col = Math.min(GRID, Math.max(1, col));
    e.preventDefault();

    const position = toPosition(row, col);
    if (position === focusPos) return;
    setFocusPos(position);
    onPick(row, col);
    requestAnimationFrame(() => {
      gridRef.current?.querySelector(`[data-pos="${position}"]`)?.focus();
    });
  }

  return (
    <div className="tile-board-wrap">
      <div
        className="tile-board builder-board"
        ref={gridRef}
        onKeyDown={onKeyDown}
      >
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
              const position = toPosition(row, col);
              const tile = tiles.get(position);
              const here = at && at.row === row && at.col === col;
              return (
                <button
                  key={`${row}-${col}`}
                  type="button"
                  data-pos={position}
                  tabIndex={position === focusPos ? 0 : -1}
                  className={[
                    'tile-cell builder-cell',
                    tile ? '' : 'empty',
                    here ? 'on' : '',
                    playerView ? 'as-player' : '',
                    // Only while a game is live, because before one starts
                    // every square is editable and a marked-up board would be
                    // ninety-nine squares of noise around nothing.
                    live && tile?.claimed ? 'claimed' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => onPick(row, col)}
                  title={live && tile?.claimed
                    ? `${tile.name} — locked in by a team`
                    : tile ? tile.name : `${coordLabel(row, col)} — empty`}
                >
                  {/* In the player view the artwork is the whole cell, the
                      way it is on the enemy board: no caption to read the
                      square by, which is the point of looking. `standIn` so a
                      square with no icon shows the same placeholder a team
                      would actually be given, rather than looking empty. */}
                  {!playerView && <b>{coordLabel(row, col)}</b>}
                  {playerView
                    ? <TileIcon slug={tile?.icon} standIn={Boolean(tile)} fallback={null} />
                    : tile?.icon && <TileIcon slug={tile.icon} fallback={null} />}
                  {!playerView && <span>{tile?.name ?? ''}</span>}
                </button>
              );
            }),
          ];
        })}
      </div>
    </div>
  );
}
