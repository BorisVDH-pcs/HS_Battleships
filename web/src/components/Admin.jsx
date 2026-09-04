import { useCallback, useEffect, useState } from 'react';
import {
  supabase, startGame,
  adminCreateGame, adminSetTiles, adminSetMember, adminRemoveMember,
  adminOpenPlacement, adminListTiles, adminDeleteGame, adminResetGame,
  adminListShipCells, adminListWebhooks,
} from '../lib/supabase.js';
import AdminOverview from './AdminOverview.jsx';
import Scoreboard from './Scoreboard.jsx';
import TeamNameEditor from './TeamNameEditor.jsx';
import EvidenceReview from './EvidenceReview.jsx';
import DiscordWebhooks from './DiscordWebhooks.jsx';
import TileBoard from './TileBoard.jsx';
import { useConfirm } from './ConfirmDialog.jsx';
import { statusLabel } from '../lib/status.js';

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

export default function Admin() {
  const [games, setGames] = useState([]);
  const [teams, setTeams] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [members, setMembers] = useState([]);
  const [tiles, setTiles] = useState([]);
  const [scores, setScores] = useState([]);
  const [shipCells, setShipCells] = useState([]);
  const [webhooks, setWebhooks] = useState([]);
  const [gameId, setGameId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [confirm, confirmDialog] = useConfirm();

  const game = games.find((g) => g.id === gameId) ?? null;
  const gameTeams = teams.filter((t) => t.game_id === gameId);

  const loadGames = useCallback(async () => {
    const [{ data: g }, { data: t }, { data: p }, { data: m }] = await Promise.all([
      supabase.from('games').select('*').order('created_at', { ascending: false }),
      supabase.from('teams').select('*'),
      supabase.from('profiles').select('id, display_name, is_admin').order('display_name'),
      supabase.from('team_members').select('team_id, profile_id, role'),
    ]);
    setGames(g ?? []);
    setTeams(t ?? []);
    setProfiles(p ?? []);
    setMembers(m ?? []);
  }, []);

  const loadGameDetail = useCallback(async (id) => {
    if (!id) { setTiles([]); setScores([]); setShipCells([]); setWebhooks([]); return; }
    try {
      // Fleets and webhooks are fetched here, not left to the panels that show
      // them, because the checklist has to answer "is this ready to start"
      // before the organiser has scrolled as far as either panel.
      const [t, { data: sc }, ships, hooks] = await Promise.all([
        adminListTiles(id),
        supabase.rpc('team_scores', { p_game_id: id }),
        adminListShipCells(id),
        adminListWebhooks(id),
      ]);
      setTiles(t ?? []);
      setScores(sc ?? []);
      setShipCells(ships ?? []);
      setWebhooks(hooks ?? []);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => { loadGames(); }, [loadGames]);
  useEffect(() => { loadGameDetail(gameId); }, [gameId, loadGameDetail]);

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

  async function run(fn, okMessage) {
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await fn();
      await loadGames();
      await loadGameDetail(gameId);
      if (okMessage) setNotice(typeof okMessage === 'function' ? okMessage(result) : okMessage);
      return result;
    } catch (err) {
      setError(err.message);
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
        ? 'Paste the task list into Tiles below.'
        : `${needTiles - tiles.length} still missing — see Tiles below.`,
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

  return (
    <div className="admin">
      {error && <p className="error">{error}</p>}
      {notice && <p className="muted">{notice}</p>}

      <NewGame busy={busy} onCreate={(...args) =>
        run(() => adminCreateGame(...args), 'Game created. Add its tiles next.')
          .then((id) => { if (id) setGameId(id); })
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
                  <button className="ghost" onClick={() => setGameId(g.id === gameId ? null : g.id)}>
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
                      if (gameId === g.id) setGameId(null);
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

      {game && (
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

          <Tiles
            game={game}
            tiles={tiles}
            busy={busy}
            onSave={(rows) =>
              run(() => adminSetTiles(game.id, rows), (n) => `${n} tiles saved.`)
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

          {/* No heading here: Scoreboard renders its own <h2>Score</h2>, and
              wrapping it in a section with a second one printed the word twice. */}
          <section className="card">
            <Scoreboard scores={scores} myTeamId={null} />
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

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  // Three fields at most: name | icon | amount. Splitting on the FIRST pipe and
  // keeping the remainder as the icon (which this did until now) meant a third
  // field landed inside the slug, and admin_set_tiles then scrubbed it to
  // `[A-Za-z0-9_-]` — so `Tile | slayer_helmet | 3` silently became the slug
  // `slayer_helmet3` and a missing picture, rather than an evidence count.
  const rows = lines.map((line, i) => {
    const [name, icon, amount] = line.split('|');
    const raw = (amount ?? '').trim();
    // A trailing + marks a tile with more than one route to done: the number is
    // the worst case, and the team may declare it finished sooner (0025).
    const early = raw.endsWith('+');
    const n = parseInt(early ? raw.slice(0, -1) : raw, 10);
    return {
      row: Math.floor(i / game.grid_size) + 1,
      col: (i % game.grid_size) + 1,
      name: (name ?? '').trim(),
      // Slug only; admin_set_tiles strips anything else server-side.
      icon: (icon ?? '').trim(),
      // Omitted rather than defaulted, so the server keeps owning the default.
      // It clamps to 1..30; this only decides whether to send a number at all.
      ...(Number.isFinite(n) ? { amount: n } : {}),
      ...(early ? { early: true } : {}),
    };
  });

  // Worth naming before the save rather than after: the server clamps a silly
  // amount into range instead of refusing it, so a typo would be stored as a
  // plausible number and nobody would know which tile it landed on.
  const badAmounts = rows
    .map((r, i) => ({ line: i + 1, amount: r.amount }))
    .filter((r) => r.amount !== undefined && (r.amount < 1 || r.amount > 30));
  // A bare + with no number reads as "some other route" but sets no worst case,
  // which would leave the tile at 1 and the marker doing nothing.
  const earlyWithoutAmount = rows
    .map((r, i) => ({ line: i + 1, ...r }))
    .filter((r) => r.early && r.amount === undefined);

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
                Add <code>+</code> after the amount — <code>… | 18+</code> — for a
                tile that can be finished more than one way. The number is then
                the worst case, and the team gets a <em>Complete Early</em>
                {' '}button once it has submitted at least one screenshot. Use it
                only where a cheaper route genuinely exists: without the{' '}
                <code>+</code>, the amount is the only way to finish.
              </p>
              {/* The placeholder's examples are invented on purpose: this string
                  ships in the public bundle, and the tile list is secret #2 — a
                  placeholder is no place to publish three real squares. */}
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={'A task | some_icon\nA task needing five drops | some_icon | 5\nA task with a shorter route | some_icon | 19+\n…'}
              />
              {badAmounts.length > 0 && (
                <p className="error">
                  {badAmounts.length === 1
                    ? `Line ${badAmounts[0].line} asks for ${badAmounts[0].amount} pieces of evidence`
                    : `${badAmounts.length} lines ask for an amount`}
                  {' '}outside 1–30. The server would clamp it into range rather
                  than refuse it, so fix it here.
                </p>
              )}
              {earlyWithoutAmount.length > 0 && (
                <p className="error">
                  {earlyWithoutAmount.length === 1
                    ? `Line ${earlyWithoutAmount[0].line} has a + with no number`
                    : `${earlyWithoutAmount.length} lines have a + with no number`}
                  . That tile would need one screenshot anyway, so the marker
                  would do nothing — give it the worst case, or drop the +.
                </p>
              )}
              <div className="row" style={{ marginTop: '.6rem' }}>
                <button
                  disabled={busy || rows.length !== need
                            || badAmounts.length > 0 || earlyWithoutAmount.length > 0}
                  onClick={() => onSave(rows).then(() => { setText(''); setOpen(false); })}
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
