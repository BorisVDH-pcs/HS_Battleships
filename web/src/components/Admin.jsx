import { useCallback, useEffect, useState } from 'react';
import {
  supabase, startGame,
  adminCreateGame, adminSetTiles, adminSetMember, adminRemoveMember,
  adminOpenPlacement, adminListTiles, adminDeleteGame, adminResetGame,
} from '../lib/supabase.js';
import AdminBoards from './AdminBoards.jsx';
import Scoreboard from './Scoreboard.jsx';
import TeamNameEditor from './TeamNameEditor.jsx';
import EvidenceReview from './EvidenceReview.jsx';
import TileBoard from './TileBoard.jsx';

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
  const [scores, setScores] = useState([]);
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
    if (!id) { setTiles([]); setScores([]); return; }
    try {
      const [t, { data: sc }] = await Promise.all([
        adminListTiles(id),
        supabase.rpc('team_scores', { p_game_id: id }),
      ]);
      setTiles(t ?? []);
      setScores(sc ?? []);
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

          <section className="card">
            <h2>Fleets</h2>
            <p className="muted">
              Live overview of each team’s placed ships and incoming shots.
              Captains place their own fleets from the player page.
            </p>
            <AdminBoards gameId={game.id} teams={gameTeams} />
          </section>

          <section className="card">
            <h2>Score</h2>
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
  const rows = lines.map((line, i) => {
    const [name, ...rest] = line.split('|');
    return {
      row: Math.floor(i / game.grid_size) + 1,
      col: (i % game.grid_size) + 1,
      name: name.trim(),
      // Slug only; admin_set_tiles strips anything else server-side.
      icon: rest.join('|').trim(),
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
        <p className="muted">Tiles are locked once the game is {game.status}.</p>
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
                Optionally <code>name | icon</code>, where the icon names a file
                in <code>web/public/icons</code> without the <code>.png</code>.
                Needs exactly {need} lines.
              </p>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={'Slayer tile | slayer_helmet\nDragon warhammer | dragon_warhammer\n…'}
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
