import { useCallback, useEffect, useRef, useState } from 'react';
import {
  supabase, startGame,
  adminCreateGame, adminSetTiles, adminSetMember, adminRemoveMember,
  adminOpenPlacement, adminListTiles, adminDeleteGame, adminResetGame,
  adminListShipCells, adminListWebhooks,
  adminListLibrary, adminSaveLibraryTile, adminDeleteLibraryTile,
  adminImportBoardToLibrary, adminSetTile, adminClearTile, adminAutofillBoard,
} from '../lib/supabase.js';
import BoardBuilder from './BoardBuilder.jsx';
import AdminOverview from './AdminOverview.jsx';
import TeamNameEditor from './TeamNameEditor.jsx';
import EvidenceReview from './EvidenceReview.jsx';
import DiscordWebhooks from './DiscordWebhooks.jsx';
import TileBoard from './TileBoard.jsx';
import { useConfirm } from './ConfirmDialog.jsx';
import { statusLabel } from '../lib/status.js';
import { parseTileText } from '../lib/tileParser.js';

// What to do next, in the order the checklist below lists it. The `setup` line
// used to say only "add the 100 tiles", which is why games reached Start Game
// with no roster: the hint was the whole instruction manual, and it named one
// of the four things that have to happen.
const STEP_HINT = {
  setup:     'Add the tiles and the roster, give each team a captain, then open preparation.',
  // Only a captain can place a fleet from the UI. place_fleet still accepts an
  // admin (0006), but the screen that used it — AdminBoards — is gone, and
  // AdminOverview is read-only. So the way past an absent captain is to hand
  // the role to someone who is there, not to do it for them.
  placement: 'Each team’s captain places their fleet, then start the game. '
           + 'If a captain is unavailable, pass the role to another player in Roster.',
  active:    'The game is running.',
  finished:  'This game is over.',
};

/**
 * What `run` resolves to when the action was refused.
 *
 * A symbol rather than false or null: an action that succeeded may resolve to
 * either of those, and confusing the two is how a failed save comes to look
 * like a successful one.
 */
const FAILED = Symbol('admin action failed');
const worked = (result) => result !== FAILED;

export default function Admin() {
  const [games, setGames] = useState([]);
  const [teams, setTeams] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [members, setMembers] = useState([]);
  const [tiles, setTiles] = useState([]);
  // The tile catalogue. Loaded once for the whole console rather than per game:
  // it belongs to no game, and the builder is the only thing that reads it.
  const [library, setLibrary] = useState([]);
  const [libraryError, setLibraryError] = useState(null);
  const [shipCells, setShipCells] = useState([]);
  const [webhooks, setWebhooks] = useState([]);
  const [gameId, setGameId] = useState(null);
  // Which section is on screen. The console used to be one long scroll of eight
  // cards, so finding Roster meant paging past the whole board overview.
  const [pane, setPane] = useState('games');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [confirm, confirmDialog] = useConfirm();
  const errorRef = useRef(null);

  // Scrolled to whenever a new one arrives, not merely when one is on screen —
  // two refusals in a row should still take you to the message.
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [error]);

  const game = games.find((g) => g.id === gameId) ?? null;
  const gameTeams = teams.filter((t) => t.game_id === gameId);

  const loadGames = useCallback(async () => {
    const [{ data: g }, { data: t }, { data: p }, { data: m }] = await Promise.all([
      supabase.from('games').select('*').order('created_at', { ascending: false }),
      // Creation slot: team one (the first name typed into New game) is always
      // the left board, team two always the right, and a rename never moves
      // either. See 0044 for why neither created_at nor id could answer this -
      // both teams are inserted in one statement and share a timestamp, so
      // ordering by it was ordering by a tie. This query had no order at all
      // before, which left the boards, the roster columns and the "A vs B"
      // line to whatever Postgres happened to return.
      supabase.from('teams').select('*').order('slot'),
      supabase.from('profiles').select('id, display_name, is_admin').order('display_name'),
      supabase.from('team_members').select('team_id, profile_id, role'),
    ]);
    setGames(g ?? []);
    setTeams(t ?? []);
    setProfiles(p ?? []);
    setMembers(m ?? []);
  }, []);

  const loadGameDetail = useCallback(async (id) => {
    if (!id) { setTiles([]); setShipCells([]); setWebhooks([]); return; }
    try {
      // Fleets and webhooks are fetched here, not left to the panels that show
      // them, because the checklist has to answer "is this ready to start"
      // before the organiser has scrolled as far as either panel.
      const [t, ships, hooks] = await Promise.all([
        adminListTiles(id),
        adminListShipCells(id),
        adminListWebhooks(id),
      ]);
      setTiles(t ?? []);
      setShipCells(ships ?? []);
      setWebhooks(hooks ?? []);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  /**
   * The catalogue, reported into the builder rather than across the console.
   *
   * It loads on mount, before a game is even open, so a failure here used to
   * greet every admin with a red line above the Games list — about a panel that
   * is three sections further down and has nothing to do with what they came to
   * do. Worse, the most likely failure is the one that says nothing useful to
   * anyone but a developer: `admin_list_library` not existing yet, because the
   * migration that creates it has not been pushed.
   *
   * So it fails soft. Everything else on the console keeps working, and the
   * builder says what is wrong in the place the answer matters.
   */
  const loadLibrary = useCallback(async () => {
    try {
      setLibrary((await adminListLibrary()) ?? []);
      setLibraryError(null);
    } catch (err) {
      setLibrary([]);
      setLibraryError(err.message);
    }
  }, []);

  useEffect(() => { loadGames(); }, [loadGames]);
  useEffect(() => { loadGameDetail(gameId); }, [gameId, loadGameDetail]);
  useEffect(() => { loadLibrary(); }, [loadLibrary]);

  // Team renames can originate from a captain's screen. They emit an event so
  // the organiser's labels update without a manual refresh.
  useEffect(() => {
    if (!gameId) return;
    const channel = supabase
      .channel(`admin-game:${gameId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'game_events', filter: `game_id=eq.${gameId}` },
        () => { loadGames(); loadGameDetail(gameId); }
      )
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [gameId, loadGames, loadGameDetail]);

  // The subscription above only hears game_events. Roster changes and tile
  // edits write none, so a second organiser working in another browser leaves
  // this checklist showing a game that is more ready than it looks. Re-reading
  // when the tab comes back covers it, the same way the player board does.
  useEffect(() => {
    const recheck = () => {
      if (document.hidden) return;
      loadGames();
      loadGameDetail(gameId);
    };
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', recheck);
    return () => {
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', recheck);
    };
  }, [gameId, loadGames, loadGameDetail]);

  /**
   * Run one admin action, refresh what it could have changed, and report.
   *
   * Returns FAILED — not `undefined` — when the action threw. Several actions
   * legitimately resolve to nothing, so `undefined` cannot mean "it did not
   * work", and every caller that closes a form or moves on afterwards has to be
   * able to tell the two apart. It used to swallow the error and resolve, which
   * meant a refused save looked exactly like a successful one: the form closed,
   * the builder advanced to the next square, and the only sign of trouble was a
   * red line at the top of a pane you had scrolled a long way down.
   */
  async function run(fn, okMessage) {
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await fn();
      await loadGames();
      await loadGameDetail(gameId);
      // The catalogue comes back too. Placing a tile bumps its use count and
      // editing one changes what the picker shows, so almost every builder
      // action makes the loaded copy stale — and one small query on an admin
      // console is cheaper than working out which actions those were.
      await loadLibrary();
      if (okMessage) setNotice(typeof okMessage === 'function' ? okMessage(result) : okMessage);
      return result;
    } catch (err) {
      setError(err.message);
      return FAILED;
    } finally {
      setBusy(false);
    }
  }

  // What still has to happen before this game can run.
  //
  // Every `required` row here restates a guard that start_game already enforces
  // in the database (0026, and captains in 0043). The duplication is the point:
  // the database refuses a broken game, but it refuses it at the last click,
  // in the words of a Postgres exception. This says the same thing up front,
  // while there is still something obvious to do about it.
  const needTiles = game ? game.grid_size * game.grid_size : 0;
  const fleetSize = game?.fleet?.length ?? 0;
  const teamsWithoutCaptain = gameTeams.filter(
    (t) => !members.some((m) => m.team_id === t.id && m.role === 'captain')
  );
  const teamsWithoutFleet = gameTeams.filter(
    (t) => new Set(shipCells.filter((c) => c.team_id === t.id).map((c) => c.ship_id)).size !== fleetSize
  );
  const rosterCount = members.filter((m) => gameTeams.some((t) => t.id === m.team_id)).length;

  const checks = game ? [
    {
      key: 'tiles', label: 'Tiles', required: true,
      ok: tiles.length === needTiles,
      detail: `${tiles.length} of ${needTiles}`,
      fix: tiles.length === 0
        ? 'Build the board below, or paste the task list into Tiles.'
        : `${needTiles - tiles.length} still empty — fill them in the board builder below.`,
    },
    {
      key: 'teams', label: 'Teams', required: true,
      ok: gameTeams.length === 2,
      detail: `${gameTeams.length} of 2`,
      fix: 'A game needs exactly two teams. Create it again if this is wrong.',
    },
    {
      key: 'captains', label: 'Captains', required: true,
      ok: gameTeams.length === 2 && teamsWithoutCaptain.length === 0,
      detail: `${gameTeams.length - teamsWithoutCaptain.length} of ${gameTeams.length || 2}`,
      // The one that used to fail silently: no captain means no player can
      // place that team's fleet, and nothing anywhere said so.
      fix: teamsWithoutCaptain.length
        ? `${teamsWithoutCaptain.map((t) => t.name).join(' and ')} — set a captain in Roster below, `
          + 'or nobody on that team can place its fleet.'
        : '',
    },
    {
      // Membership only. Captaincy is the row above, and failing both for one
      // missing captain would read as two separate problems.
      key: 'roster', label: 'Players', required: true,
      ok: gameTeams.length === 2 && gameTeams.every((t) => members.some((m) => m.team_id === t.id)),
      detail: `${rosterCount} assigned`,
      fix: `Both teams need at least one player — ${
        gameTeams.filter((t) => !members.some((m) => m.team_id === t.id)).map((t) => t.name).join(' and ')
        || 'add them'
      } in Roster below.`,
    },
    {
      key: 'fleets', label: 'Fleets placed', required: true,
      ok: gameTeams.length === 2 && teamsWithoutFleet.length === 0,
      detail: `${gameTeams.length - teamsWithoutFleet.length} of ${gameTeams.length || 2}`,
      fix: game.status === 'setup'
        ? 'Captains do this themselves once preparation is open.'
        : `Waiting on ${teamsWithoutFleet.map((t) => t.name).join(' and ') || 'the captains'}. `
          + 'Only a captain can place a fleet — if theirs is away, pass the role on in Roster.',
    },
    {
      key: 'discord', label: 'Discord', required: false,
      ok: webhooks.length > 0,
      detail: webhooks.length ? `${webhooks.length} configured` : 'none',
      // Optional, and worth saying so loudly: since 0042 a game with no webhook
      // posts nothing at all, and silence is easy to mistake for a fault.
      fix: 'Optional. With none set, this game posts nothing to Discord.',
    },
  ] : [];

  const blocking = checks.filter((c) => c.required && !c.ok);
  const canOpenPreparation = checks.every((c) => c.key !== 'tiles' || c.ok)
    && teamsWithoutCaptain.length === 0 && gameTeams.length === 2 && rosterCount > 0;
  const canStart = blocking.length === 0;

  function blockedReason(forStatus) {
    if (!game || game.status !== forStatus) return undefined;
    const missing = forStatus === 'setup'
      ? blocking.filter((c) => c.key !== 'fleets')
      : blocking;
    if (missing.length === 0) return undefined;
    return 'Still needed: ' + missing.map((c) => c.label.toLowerCase()).join(', ');
  }

  // Keep this badge in sync with the setup overview: it represents everything
  // still blocking the game, including fleets that captains place later.
  const configureBadge = blocking.length;

  // Configure and Track are both about a chosen game, so with none chosen there
  // is nothing for them to show. Derived rather than corrected in an effect, so
  // deleting the open game cannot leave the console pointing at a blank pane.
  const activePane = !game && pane !== 'games' ? 'games' : pane;

  const sections = [
    {
      key: 'games', label: 'Games', badge: 0, enabled: true,
      hint: 'Create one, or pick one to work on',
    },
    {
      key: 'configure', label: 'Configure', badge: configureBadge, enabled: Boolean(game),
      hint: game ? 'Tiles, teams, roster, Discord' : 'Pick a game first',
    },
    {
      key: 'track', label: 'Track', badge: 0, enabled: Boolean(game),
      hint: game ? 'Boards and evidence' : 'Pick a game first',
    },
  ];

  return (
    <div className="admin-split">
      {/* Which section is on screen, and — once a game is open — which game every
          section is talking about. Sticky, so that answer travels with you down
          a long pane instead of scrolling off the top. */}
      <nav className="admin-nav" aria-label="Admin sections">
        {game && (
          <div className="admin-nav-game">
            <span className="admin-nav-game-name">{game.name}</span>
            <span className={`pill ${game.status}`}>{statusLabel(game.status)}</span>
          </div>
        )}
        <ul>
          {sections.map((s) => (
            <li key={s.key}>
              <button
                className={`admin-nav-item${activePane === s.key ? ' on' : ''}`}
                aria-current={activePane === s.key ? 'page' : undefined}
                disabled={!s.enabled}
                onClick={() => setPane(s.key)}
              >
                <span className="admin-nav-label">
                  {s.label}
                  {s.badge > 0 && <span className="admin-nav-badge">{s.badge}</span>}
                </span>
                <span className="admin-nav-hint">{s.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="admin">
      {/* Brought into view rather than left where it renders. The console is a
          long pane and the error line lives at the top of it, so a refusal
          raised from the board builder — most of a page further down — used to
          be announced somewhere the organiser was not looking. */}
      {error && <p className="error" ref={errorRef} role="alert">{error}</p>}
      {notice && <p className="muted">{notice}</p>}

      {activePane === 'games' && <>
      <NewGame busy={busy} onCreate={(...args) =>
        run(() => adminCreateGame(...args), 'Game created. Add its tiles next.')
          .then((id) => { if (worked(id) && id) { setGameId(id); setPane('configure'); } })
      } />

      <section className="card">
        <h2>Games</h2>
        {games.length === 0 && <p className="muted">No games yet.</p>}
        <ul className="game-list">
          {games.map((g) => {
            const names = teams.filter((t) => t.game_id === g.id).map((t) => t.name);
            return (
              <li key={g.id} className={g.id === gameId ? 'on' : ''}>
                <div>
                  <strong>{g.name}</strong>{' '}
                  <span className={`pill ${g.status}`}>{statusLabel(g.status)}</span>
                  <div className="meta">{names.join(' vs ') || 'no teams'}</div>
                </div>
                <div className="row">
                  {/* Managing a game is the same gesture as opening it, so it
                      lands you in Configure rather than leaving you to find the
                      sidebar entry that just became available. */}
                  <button
                    className="ghost"
                    onClick={() => {
                      if (g.id === gameId) { setGameId(null); setPane('games'); }
                      else { setGameId(g.id); setPane('configure'); }
                    }}
                  >
                    {g.id === gameId ? 'Close' : 'Manage'}
                  </button>
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={async () => {
                      // Deleting cascades to tiles, locked-in tiles and the event feed, so
                      // make the caller name the game rather than trusting a click.
                      // The dialog holds its confirm button disabled until the
                      // name matches, so there is no mismatch to report anymore.
                      if (!(await confirm(
                        `Delete "${g.name}" and everything in it — the 100 tiles, every locked-in tile, the roster and the feed.`,
                        {
                          title: 'Delete this game?',
                          confirmLabel: 'Delete it',
                          danger: true,
                          requireText: g.name,
                        }
                      ))) return;
                      await run(() => adminDeleteGame(g.id), 'Game deleted.');
                      if (gameId === g.id) { setGameId(null); setPane('games'); }
                    }}
                  >
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
      </>}

      {activePane === 'configure' && game && (
        <>
          <section className="card">
            <h2>{game.name} — {statusLabel(game.status)}</h2>
            <p className="muted">{STEP_HINT[game.status]}</p>

            <SetupChecklist checks={checks} status={game.status} />

            <div className="row">
              <button
                disabled={busy || game.status !== 'setup' || !canOpenPreparation}
                title={blockedReason('setup')}
                onClick={() => run(() => adminOpenPlacement(game.id), 'Preparation is open.')}
              >
                Open preparation
              </button>
              <button
                disabled={busy || game.status !== 'placement' || !canStart}
                title={blockedReason('placement')}
                onClick={() => run(() => startGame(game.id), 'Game started — fleets are now frozen.')}
              >
                Start game
              </button>
            </div>

            {/* The way back out of a started game. Without it the only undo was
                Delete, which takes the 100 tiles and the roster with it. */}
            {(game.status === 'active' || game.status === 'finished') && (
              <div className="row" style={{ marginTop: '.8rem' }}>
                <button
                  className="danger"
                  disabled={busy}
                  onClick={async () => {
                    if (!(await confirm(
                      'Cleared: every locked-in tile and shot, the activity feed, manual score ' +
                      'adjustments, the winner, and both fleets.\n' +
                      'Kept: the 100 tiles and the roster.\n\n' +
                      'This cannot be undone.',
                      {
                        title: `Reset "${game.name}" to preparation?`,
                        confirmLabel: 'Reset it',
                        danger: true,
                      }
                    ))) return;
                    run(() => adminResetGame(game.id, true),
                        'Game reset. Fleets need placing again.');
                  }}
                >
                  Reset to preparation
                </button>
                <button
                  className="ghost"
                  disabled={busy}
                  onClick={async () => {
                    if (!(await confirm(
                      'Cleared: every locked-in tile and shot, the activity feed, manual score ' +
                      'adjustments, and the winner.\n' +
                      'Kept: the 100 tiles, the roster, and both fleets as placed.\n\n' +
                      'This cannot be undone.',
                      {
                        title: `Replay "${game.name}" with the same fleets?`,
                        confirmLabel: 'Reset, keep fleets',
                        danger: true,
                      }
                    ))) return;
                    run(() => adminResetGame(game.id, false),
                        'Game reset with fleets intact — press Start game when ready.');
                  }}
                >
                  Reset, keep fleets
                </button>
              </div>
            )}
          </section>

          {/* Before the paste box, because it is now the way most boards get
              built. The paste box stays below it for a board that already
              exists as text — the two write the same rows through the same
              validation, and neither is a mode you have to commit to. */}
          <BoardBuilder
            game={game}
            tiles={tiles}
            library={library}
            libraryError={libraryError}
            busy={busy}
            // Each of the three writes below answers "did it actually save",
            // because the builder closes a form and moves to the next square on
            // the strength of it.
            onSetTile={(row, col, tile) =>
              run(() => adminSetTile(game.id, row, col, tile)).then(worked)
            }
            onClearTile={(row, col) =>
              run(() => adminClearTile(game.id, row, col), 'Square cleared.').then(worked)
            }
            // Resolves to the entry's id, or null if the save was refused. The
            // builder needs the id rather than just a yes: after saving it puts
            // the tile on the square you were filling, and the square records
            // which catalogue entry it came from.
            onSaveLibraryTile={(id, tile) =>
              run(() => adminSaveLibraryTile(id, tile),
                  id ? 'Catalogue tile updated.' : 'Added to the catalogue.')
                .then((result) => (worked(result) ? result : null))
            }
            onDeleteLibraryTile={(entry) =>
              confirm(
                entry.times_used > 0
                  ? `It is on ${entry.times_used} square${entry.times_used === 1 ? '' : 's'} across past boards.\n`
                    + 'Those boards keep their own copy — only the catalogue entry goes, '
                    + 'so nothing that has been played changes.'
                  : 'It is not on any board yet.',
                {
                  title: `Remove "${entry.name}" from the catalogue?`,
                  confirmLabel: 'Remove it',
                  danger: true,
                }
              ).then((ok) => ok && run(
                () => adminDeleteLibraryTile(entry.id), 'Removed from the catalogue.'
              ))
            }
            onImportBoard={() =>
              run(() => adminImportBoardToLibrary(game.id),
                  (r) => `${r.added} added to the catalogue, ${r.skipped} already there.`)
            }
            // Says what it could not do as well as what it did. A catalogue too
            // small for the board leaves squares empty, and a shuffle that
            // reports only its successes leaves you to find that out by
            // counting a hundred squares.
            onAutofillBoard={() =>
              run(() => adminAutofillBoard(game.id), (r) => {
                const short = r.empty - r.filled;
                return `${r.filled} square${r.filled === 1 ? '' : 's'} filled.`
                  + (short > 0
                      ? ` ${short} left empty — the catalogue has ${r.pool} tile${r.pool === 1 ? '' : 's'} this board can still use.`
                      : '')
                  + (r.similar > 0
                      ? ` ${r.similar} of them repeat a task already on the board, which is what it took to fill it.`
                      : '');
              })
            }
          />

          <Tiles
            game={game}
            tiles={tiles}
            busy={busy}
            onSave={(rows) =>
              run(() => adminSetTiles(game.id, rows), (n) => `${n} tiles saved.`).then(worked)
            }
          />

          <section className="card">
            <h2>Team names</h2>
            <div className="columns">
              {gameTeams.map((team) => (
                <div key={team.id}>
                  <h3>{team.name}</h3>
                  <TeamNameEditor team={team} onRenamed={() => loadGames()} />
                </div>
              ))}
            </div>
          </section>

          <Roster
            gameTeams={gameTeams}
            profiles={profiles}
            members={members}
            busy={busy}
            onSet={(teamId, profileId, role) =>
              run(() => adminSetMember(teamId, profileId, role), 'Roster updated.')
            }
            onRemove={(teamId, profileId) =>
              run(() => adminRemoveMember(teamId, profileId), 'Player removed.')
            }
          />

          {/* Setting up, not running: it belongs with Tiles and Roster rather
              than between Score and Evidence, where it sat before. Since 0042 a
              game with no webhook posts nothing, so this is now a step someone
              has to actively decide to skip, not one they can fail to notice. */}
          <DiscordWebhooks
            gameId={game.id}
            gameTeams={gameTeams}
            onChanged={() => loadGameDetail(game.id)}
          />
        </>
      )}

      {/* Watching a game that is already set up. Both of these fetch on mount,
          so keeping them in their own pane also means a game you only came in to
          configure no longer loads every board and every screenshot first. */}
      {activePane === 'track' && game && (
        <>
          <section className="card">
            <h2>Boards</h2>
            <p className="muted">
              One board per team, showing the game from that team’s side: the
              opponent’s ships they are hunting, and their own locked-in tiles and shots
              on top. A locked-in square shows its evidence count — 1/3 is a team
              mid-task — and clicking one opens what they have submitted for it.
            </p>
            <AdminOverview gameId={game.id} teams={gameTeams} />
          </section>

          <section className="card">
            <h2>Evidence</h2>
            <p className="muted">
              Every screenshot submitted, newest first, with who submitted it.
              There is nothing to approve — attaching the required number is what
              lets a team fire. This is for settling a dispute, or catching one.
            </p>
            <EvidenceReview gameId={game.id} />
          </section>
        </>
      )}

      {confirmDialog}
      </div>
    </div>
  );
}

/**
 * What still has to happen before this game can run.
 *
 * There is no written runbook, and the people setting up a game will not be the
 * people who built this. So the panel has to be the runbook: every requirement
 * visible at once, each with the screen that satisfies it named in the fix, and
 * nothing discovered only by pressing a button and reading an error.
 *
 * Rows in `setup` and `placement` only. Once a game is running the list has
 * served its purpose and would just be six ticks taking up the top of the page.
 */
function SetupChecklist({ checks, status }) {
  if (status !== 'setup' && status !== 'placement') return null;

  const outstanding = checks.filter((c) => c.required && !c.ok);

  return (
    <div className="checklist">
      <ul>
        {checks.map((c) => (
          <li key={c.key} className={c.ok ? 'ok' : (c.required ? 'todo' : 'optional')}>
            <span className="tick" aria-hidden="true">{c.ok ? '✓' : (c.required ? '✗' : '–')}</span>
            <span className="what">
              {c.label}
              {!c.required && <span className="muted"> (optional)</span>}
            </span>
            <span className="detail">{c.detail}</span>
            {!c.ok && c.fix && <span className="fix">{c.fix}</span>}
          </li>
        ))}
      </ul>
      <p className="muted">
        {outstanding.length === 0
          ? 'Everything needed is in place.'
          : `${outstanding.length} thing${outstanding.length === 1 ? '' : 's'} still to do before this game can start.`}
      </p>
    </div>
  );
}

function NewGame({ busy, onCreate }) {
  const [name, setName] = useState('');
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  return (
    <section className="card">
      <h2>New game</h2>
      <div className="row">
        <label>Game name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Battleships V4" /></label>
        <label>Team one<input value={a} onChange={(e) => setA(e.target.value)} placeholder="Team Alpha" /></label>
        <label>Team two<input value={b} onChange={(e) => setB(e.target.value)} placeholder="Team Bravo" /></label>
        <button
          disabled={busy || !name.trim() || !a.trim() || !b.trim()}
          onClick={() => { onCreate(name, a, b); setName(''); setA(''); setB(''); }}
        >
          Create
        </button>
      </div>
    </section>
  );
}

/**
 * Tiles are pasted rather than typed one by one: 100 of them came out of the
 * Middleman sheet as rows, and retyping them into a form would be its own event.
 * One line per tile, in board order, `name | icon`.
 */
function Tiles({ game, tiles, busy, onSave }) {
  const need = game.grid_size * game.grid_size;
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);

  const { lines, rows, errors: tileErrors } = parseTileText(text, game.grid_size);

  const locked = game.status !== 'setup' && game.status !== 'placement';

  return (
    <section className="card">
      <h2>Tiles</h2>
      <p className="muted">
        {tiles.length} of {need} saved.
        {tiles.length > 0 && ` First: ${tiles[0].name}. Last: ${tiles[tiles.length - 1].name}.`}
      </p>

      {/* Outside the `locked` branch on purpose: checking what is on the board
          is most useful mid-game, which is exactly when editing is forbidden. */}
      {tiles.length > 0 && (
        <TileBoard
          tiles={tiles}
          canEdit={!locked}
          editOpen={open}
          onToggleEdit={() => setOpen(!open)}
        />
      )}

      {locked ? (
        <p className="muted">Tiles are locked once the game is {statusLabel(game.status)}.</p>
      ) : (
        <>
          {tiles.length === 0 && (
            <button className="ghost" onClick={() => setOpen(!open)}>
              {open ? 'Cancel' : 'Add tiles'}
            </button>
          )}
          {open && (
            <>
              <p className="muted" style={{ marginTop: '.8rem' }}>
                One line per tile, in board order (A1, B1 … J1, then A2 …).
                <code>name | icon | amount</code>, where the icon names a file in{' '}
                <code>web/public/icons</code> without the <code>.png</code>, and
                amount is how many screenshots that tile needs before it fires
                (1–30, default 1). Both are optional, but a tile with an amount
                and no icon still needs the empty middle field —{' '}
                <code>Tile || 3</code>. Needs exactly {need} lines.
              </p>
              <p className="muted">
                For a tile whose drops are worth different amounts, price them
                after a <code>&gt;</code>:{' '}
                <code>Tile | icon | 6 &gt; Rare:6, Mid:3, Common:2</code>. The
                amount is then a target in <em>points</em>, each screenshot is
                worth the drop it shows, and the tile fires once the total
                reaches the target. A team may hand in the same drop as many
                times as it got it, so any mix that adds up counts.
              </p>
              <p className="muted">
                Set rules use the amount field too. <code>set</code> completes
                any one whole group, and <code>each</code> collects every listed
                drop once; add a number for more than one per group. Group a
                drop with a slash:{' '}
                <code>Armour | icon | set &gt; Set A/Helm, Set A/Body, Set B/Helm, Set B/Body</code>
                {' '}or <code>Raids | icon | each 2 &gt; Raid A/Drop 1, Raid A/Drop 2, Raid B/Drop 1, Raid B/Drop 2</code>.
                A value target such as <code>250m</code> asks the player to enter
                each submitted drop's value in millions.
              </p>
              <p className="muted">
                Anything after <code>::</code> is the tile's explanation —{' '}
                <code>Tile | icon | 2 :: Dupes allowed</code>. It shows behind a{' '}
                <strong>?</strong> on the team's active-tile card, and only for
                the team that has locked the tile in. Write it as prose: pipes,
                colons and links are all safe there, because the rest of the line
                stops at the <code>::</code>.
              </p>
              {/* The placeholder's examples are invented on purpose: this string
                  ships in the public bundle, and the tile list is secret #2 — a
                  placeholder is no place to publish three real squares. */}
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={'A task | some_icon\nA task needing five drops | some_icon | 5\nA task with a shorter route | some_icon | 19+\nA task with drops worth different amounts | some_icon | 6 > Rare:6, Mid:3, Common:2\nA complete set | armour | set > Set A/Helm, Set A/Body, Set B/Helm, Set B/Body\nDrops from every raid | raids | each 2 > Raid A/Drop 1, Raid A/Drop 2, Raid B/Drop 1, Raid B/Drop 2\nA value target | coins | 250m\nA task that needs explaining | some_icon | 2 :: Only the ones dropped by the boss count\n…'}
              />
              {tileErrors.length > 0 && (
                <ul className="error">
                  {tileErrors.map((message) => <li key={message}>{message}</li>)}
                </ul>
              )}
              <div className="row" style={{ marginTop: '.6rem' }}>
                <button
                  disabled={busy || rows.length !== need || tileErrors.length > 0}
                  // Only cleared once the save actually landed. Wiping a
                  // hundred pasted lines because the database refused them is
                  // the worst possible response to an error.
                  onClick={() => onSave(rows).then((ok) => {
                    if (ok) { setText(''); setOpen(false); }
                  })}
                >
                  Save {rows.length} tiles
                </button>
                <span className={rows.length === need ? 'muted' : 'error'}>
                  {rows.length} / {need} lines
                </span>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

function Roster({ gameTeams, profiles, members, busy, onSet, onRemove }) {
  const [pick, setPick] = useState({});

  return (
    <section className="card">
      <h2>Roster</h2>
      <div className="columns">
        {gameTeams.map((t) => {
          const mine = members.filter((m) => m.team_id === t.id);
          const taken = new Set(
            members
              .filter((m) => gameTeams.some((g) => g.id === m.team_id))
              .map((m) => m.profile_id)
          );
          // Admin accounts are run-the-event accounts, not players — keep them
          // out of the picker so nobody drafts the organiser onto a team.
          const free = profiles.filter((p) => !taken.has(p.id) && !p.is_admin);
          return (
            <div key={t.id}>
              <h3>{t.name}</h3>
              <ul className="roster">
                {mine.map((m) => {
                  const p = profiles.find((x) => x.id === m.profile_id);
                  return (
                    <li key={m.profile_id}>
                      <span className={m.role === 'captain' ? 'captain' : ''}>
                        {p?.display_name ?? 'unknown'}{m.role === 'captain' && ' · captain'}
                      </span>
                      <span className="row">
                        <button
                          className="ghost" disabled={busy}
                          onClick={() => onSet(t.id, m.profile_id, m.role === 'captain' ? 'member' : 'captain')}
                        >
                          {m.role === 'captain' ? 'Demote' : 'Make captain'}
                        </button>
                        <button className="danger" disabled={busy} onClick={() => onRemove(t.id, m.profile_id)}>
                          Remove
                        </button>
                      </span>
                    </li>
                  );
                })}
                {mine.length === 0 && <li className="muted">Nobody yet.</li>}
              </ul>
              <div className="row" style={{ marginTop: '.6rem' }}>
                <label>
                  Add player
                  <select
                    value={pick[t.id] ?? ''}
                    onChange={(e) => setPick({ ...pick, [t.id]: e.target.value })}
                  >
                    <option value="">Choose…</option>
                    {free.map((p) => (
                      <option key={p.id} value={p.id}>{p.display_name}</option>
                    ))}
                  </select>
                </label>
                <button
                  disabled={busy || !pick[t.id]}
                  onClick={() => { onSet(t.id, pick[t.id], 'member'); setPick({ ...pick, [t.id]: '' }); }}
                >
                  Add
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <p className="muted" style={{ marginTop: '.8rem' }}>
        Players appear here once they have signed up on the login screen.
        Only a captain (or you) can place that team’s fleet.
      </p>
    </section>
  );
}
