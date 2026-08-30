import { useCallback, useEffect, useState } from 'react';
import {
  supabase, startGame,
  adminCreateGame, adminSetTiles, adminSetMember, adminRemoveMember,
  adminOpenPlacement, adminListTiles, adminListShipCells, adminDeleteGame, adminResetGame,
  adminAdjustScore, adminListScoreEvents, adminDeleteScoreEvent, adminSetScoring,
} from '../lib/supabase.js';
import FleetPlacer from './FleetPlacer.jsx';
import AdminBoards from './AdminBoards.jsx';
import Scoreboard from './Scoreboard.jsx';

const STEP_HINT = {
  setup:     'Add the 100 tiles, then open placement.',
  placement: 'Place both fleets, then start the game.',
  active:    'The game is running.',
  finished:  'This game is over.',
};

export default function Admin() {
  const [games, setGames] = useState([]);
  const [teams, setTeams] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [members, setMembers] = useState([]);
  const [tiles, setTiles] = useState([]);
  const [shipCells, setShipCells] = useState([]);
  const [scores, setScores] = useState([]);
  const [scoreEvents, setScoreEvents] = useState([]);
  const [gameId, setGameId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

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
    if (!id) { setTiles([]); setShipCells([]); setScores([]); setScoreEvents([]); return; }
    try {
      const [t, s, adjustments, { data: sc }] = await Promise.all([
        adminListTiles(id),
        adminListShipCells(id),
        adminListScoreEvents(id),
        supabase.rpc('team_scores', { p_game_id: id }),
      ]);
      setTiles(t ?? []);
      setShipCells(s ?? []);
      setScoreEvents(adjustments ?? []);
      setScores(sc ?? []);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => { loadGames(); }, [loadGames]);
  useEffect(() => { loadGameDetail(gameId); }, [gameId, loadGameDetail]);

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
                  <span className={`pill ${g.status}`}>{g.status}</span>
                  <div className="meta">{names.join(' vs ') || 'no teams'}</div>
                </div>
                <div className="row">
                  <button className="ghost" onClick={() => setGameId(g.id === gameId ? null : g.id)}>
                    {g.id === gameId ? 'Close' : 'Manage'}
                  </button>
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={() => {
                      // Deleting cascades to tiles, claims and the event feed, so
                      // make the caller name the game rather than trusting a click.
                      const typed = window.prompt(
                        `Delete "${g.name}" and everything in it? Type the game name to confirm.`
                      );
                      if (typed === null) return;
                      if (typed.trim() !== g.name) { setError('Name did not match — nothing deleted.'); return; }
                      run(() => adminDeleteGame(g.id), 'Game deleted.').then(() => {
                        if (gameId === g.id) setGameId(null);
                      });
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
            <h2>{game.name} — {game.status}</h2>
            <p className="muted">{STEP_HINT[game.status]}</p>
            <div className="row">
              <button
                disabled={busy || game.status !== 'setup'}
                onClick={() => run(() => adminOpenPlacement(game.id), 'Placement is open.')}
              >
                Open placement
              </button>
              <button
                disabled={busy || game.status !== 'placement'}
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
                  onClick={() => {
                    if (!window.confirm(
                      `Reset "${game.name}" back to placement?\n\n` +
                      'Cleared: every claim and shot, the activity feed, manual score ' +
                      'adjustments, the winner, and both fleets.\n' +
                      'Kept: the 100 tiles and the roster.\n\n' +
                      'This cannot be undone.'
                    )) return;
                    run(() => adminResetGame(game.id, true),
                        'Game reset. Fleets need placing again.');
                  }}
                >
                  Reset to placement
                </button>
                <button
                  className="ghost"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm(
                      `Replay "${game.name}" with the same fleets?\n\n` +
                      'Cleared: every claim and shot, the activity feed, manual score ' +
                      'adjustments, and the winner.\n' +
                      'Kept: the 100 tiles, the roster, and both fleets as placed.\n\n' +
                      'This cannot be undone.'
                    )) return;
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

          <section className="card">
            <h2>Fleets</h2>
            {game.status === 'placement' ? (
              <div className="columns">
                {gameTeams.map((t) => (
                  <div key={t.id}>
                    <FleetPlacer
                      teamId={t.id}
                      teamName={t.name}
                      fleet={game.fleet}
                      onPlaced={() => run(async () => {}, `${t.name} fleet saved.`)}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <>
                <p className="muted">
                  {game.status === 'setup'
                    ? 'Open placement before positioning fleets.'
                    : 'Fleets are frozen once the game starts.'}
                </p>
                <AdminBoards gameId={game.id} teams={gameTeams} />
              </>
            )}
          </section>

          <Scoring
            key={game.id}
            game={game}
            gameTeams={gameTeams}
            scores={scores}
            scoreEvents={scoreEvents}
            profiles={profiles}
            members={members}
            busy={busy}
            onAward={(teamId, delta, reason, profileId) =>
              run(() => adminAdjustScore(teamId, delta, reason, profileId), 'Score adjusted.')
            }
            onUndo={(id) =>
              run(() => adminDeleteScoreEvent(id), 'Adjustment reverted.')
            }
            onWeights={(perTile, perHit, perSink) =>
              run(() => adminSetScoring(game.id, perTile, perHit, perSink), 'Scoring updated.')
            }
          />
        </>
      )}
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
        <label>Team one<input value={a} onChange={(e) => setA(e.target.value)} placeholder="Flikkerlikkers" /></label>
        <label>Team two<input value={b} onChange={(e) => setB(e.target.value)} placeholder="Kriegsmarine" /></label>
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
 * One line per tile, in board order, `name | rules`.
 */
function Tiles({ game, tiles, busy, onSave }) {
  const need = game.grid_size * game.grid_size;
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const rows = lines.map((line, i) => {
    const [name, ...rest] = line.split('|');
    return {
      row: Math.floor(i / game.grid_size) + 1,
      col: (i % game.grid_size) + 1,
      name: name.trim(),
      rules: rest.join('|').trim(),
    };
  });

  const locked = game.status !== 'setup' && game.status !== 'placement';

  return (
    <section className="card">
      <h2>Tiles</h2>
      <p className="muted">
        {tiles.length} of {need} saved.
        {tiles.length > 0 && ` First: ${tiles[0].name}. Last: ${tiles[tiles.length - 1].name}.`}
      </p>

      {locked ? (
        <p className="muted">Tiles are locked once the game is {game.status}.</p>
      ) : (
        <>
          <button className="ghost" onClick={() => setOpen(!open)}>
            {open ? 'Cancel' : tiles.length ? 'Replace tiles' : 'Add tiles'}
          </button>
          {open && (
            <>
              <p className="muted" style={{ marginTop: '.8rem' }}>
                One line per tile, in board order (A1, B1 … J1, then A2 …).
                Optionally <code>name | rules</code>. Needs exactly {need} lines.
              </p>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={'Slayer task | Any boss task counts\nBarrows chest | Solo only\n…'}
              />
              <div className="row" style={{ marginTop: '.6rem' }}>
                <button
                  disabled={busy || rows.length !== need}
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

/**
 * Scoring. The totals themselves cannot be edited: they are derived by the
 * `team_scores` function from tiles fired, hits and sinkings. What an organiser
 * controls is the weighting, and the manual adjustments on top — which is all
 * the spreadsheet's "+1" button ever was.
 *
 * Mounted with key={game.id} by the parent, so switching games resets the form
 * rather than carrying the previous game's weights into it.
 */
function Scoring({
  game, gameTeams, scores, scoreEvents, profiles, members,
  busy, onAward, onUndo, onWeights,
}) {
  const [teamId, setTeamId] = useState('');
  const [delta, setDelta] = useState('1');
  const [reason, setReason] = useState('');
  const [profileId, setProfileId] = useState('');
  const [perTile, setPerTile] = useState(String(game.points_per_tile ?? 1));
  const [perHit, setPerHit] = useState(String(game.points_per_hit ?? 0));
  const [perSink, setPerSink] = useState(String(game.points_per_sink ?? 0));

  const n = Number(delta);
  const canAward = Boolean(teamId) && Number.isInteger(n) && n !== 0 && reason.trim().length > 0;

  const teamPlayers = members
    .filter((m) => m.team_id === teamId)
    .map((m) => profiles.find((p) => p.id === m.profile_id))
    .filter(Boolean);

  const weightsChanged =
    Number(perTile) !== game.points_per_tile ||
    Number(perHit) !== game.points_per_hit ||
    Number(perSink) !== game.points_per_sink;

  function award() {
    onAward(teamId, n, reason.trim(), profileId || null);
    setReason('');
    setProfileId('');
  }

  return (
    <section className="card">
      <h2>Score</h2>

      <Scoreboard scores={scores} myTeamId={null} game={game} />

      <h3 style={{ marginTop: '1.2rem' }}>What earns points</h3>
      <div className="row">
        <label>Per tile completed
          <input type="number" value={perTile} onChange={(e) => setPerTile(e.target.value)} />
        </label>
        <label>Per hit
          <input type="number" value={perHit} onChange={(e) => setPerHit(e.target.value)} />
        </label>
        <label>Per ship sunk
          <input type="number" value={perSink} onChange={(e) => setPerSink(e.target.value)} />
        </label>
        <button
          disabled={busy || !weightsChanged}
          onClick={() => onWeights(Number(perTile), Number(perHit), Number(perSink))}
        >
          Save
        </button>
      </div>
      <p className="muted">
        Changing these re-totals both teams immediately — nothing is stored, so
        there is no history to rewrite.
      </p>

      <h3 style={{ marginTop: '1.2rem' }}>Manual adjustment</h3>
      <div className="row">
        <label>Team
          <select value={teamId} onChange={(e) => { setTeamId(e.target.value); setProfileId(''); }}>
            <option value="">Choose…</option>
            {gameTeams.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </label>
        <label>Points
          <input type="number" value={delta} onChange={(e) => setDelta(e.target.value)} />
        </label>
        <label>Reason
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Completed the bonus objective"
          />
        </label>
        <label>Credit a player
          <select
            value={profileId}
            disabled={!teamId}
            onChange={(e) => setProfileId(e.target.value)}
          >
            <option value="">Nobody in particular</option>
            {teamPlayers.map((p) => (
              <option key={p.id} value={p.id}>{p.display_name}</option>
            ))}
          </select>
        </label>
        <button disabled={busy || !canAward} onClick={award}>Apply</button>
      </div>
      <p className="muted">
        The other team sees only that the score moved, never the reason. Their own
        team does see it, so keep tile names out of it — naming a tile they have
        not claimed gives it away on the shared grid.
      </p>

      <h3 style={{ marginTop: '1.2rem' }}>Adjustments</h3>
      <ul className="roster">
        {scoreEvents.map((se) => (
          <li key={se.id}>
            <span>
              <strong>{se.delta > 0 ? `+${se.delta}` : se.delta}</strong>{' '}
              {se.team_name}
              {se.display_name ? ` · ${se.display_name}` : ''}
              <div className="meta">{se.reason}</div>
            </span>
            <button className="danger" disabled={busy} onClick={() => onUndo(se.id)}>
              Undo
            </button>
          </li>
        ))}
        {scoreEvents.length === 0 && <li className="muted">No manual adjustments yet.</li>}
      </ul>
    </section>
  );
}
