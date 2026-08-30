import { useEffect, useRef, useState } from 'react';
import { supabase, isSupabaseConfigured, claimTile } from './lib/supabase.js';
import { useGame } from './hooks/useGame.js';
import Login from './components/Login.jsx';
import EnemyGrid from './components/EnemyGrid.jsx';
import MyFleet from './components/MyFleet.jsx';
import ActiveTiles from './components/ActiveTiles.jsx';
import EventFeed from './components/EventFeed.jsx';
import Scoreboard from './components/Scoreboard.jsx';
import CaptainPlacement from './components/CaptainPlacement.jsx';
import Admin from './components/Admin.jsx';

export default function App() {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);
  const [gameId, setGameId] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busyTileId, setBusyTileId] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (!supabase) { setReady(true); return; }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  // The address behind a player's username is synthetic and must never be shown
  // (see lib/auth.js). The username is already in the session's user metadata —
  // set at sign-up, and by the admin snippet — so no extra query is needed.
  const displayName = session?.user?.user_metadata?.display_name ?? '';

  // Pick the most recent game the player can see.
  useEffect(() => {
    if (!supabase || !session) return;
    supabase
      .from('games')
      .select('id')
      .order('created_at', { ascending: false })
      .limit(1)
      .then(({ data }) => setGameId(data?.[0]?.id ?? null));
  }, [session]);

  // Whether to offer the admin tab. Cosmetic only — every admin RPC re-checks
  // is_admin() server-side, so faking this flag buys nothing.
  useEffect(() => {
    if (!supabase || !session) { setIsAdmin(false); return; }
    supabase
      .from('profiles')
      .select('is_admin')
      .eq('id', session.user.id)
      .maybeSingle()
      .then(({ data }) => setIsAdmin(Boolean(data?.is_admin)));
  }, [session]);

  const game = useGame(gameId, session);

  // Signed up, but no captain has picked them yet. Showing the board here would
  // be a game they cannot touch, with the reason buried in a grey clause — so
  // they get a waiting room instead.
  const waitingForTeam =
    !isAdmin && !game.loading && Boolean(game.game) && !game.myTeamId;

  // Being added to a team writes no game_event, so the Realtime subscription
  // never fires for it. Poll while waiting so the page lets them in by itself
  // rather than needing to be told to refresh. Must sit above the early returns
  // below — a hook after a conditional return is a hook that sometimes vanishes.
  const refreshRef = useRef(game.refresh);
  refreshRef.current = game.refresh;
  useEffect(() => {
    if (!waitingForTeam) return;
    const id = setInterval(() => refreshRef.current?.(), 10000);
    return () => clearInterval(id);
  }, [waitingForTeam]);

  if (!isSupabaseConfigured) {
    return (
      <main className="app">
        <h1>HS Battleships</h1>
        <p className="error">
          Supabase is not configured. Copy <code>.env.example</code> to{' '}
          <code>web/.env</code> and fill in the project URL and anon key.
        </p>
      </main>
    );
  }

  if (!ready) return <main className="app"><p>Loading…</p></main>;
  if (!session) return <main className="app"><Login /></main>;

  async function onClaim(tile) {
    // A grid cell is a small target, especially on a phone, and a claim is not
    // free: it takes one of the team's active slots until the tile is fired.
    // Firing already confirms in ActiveTiles; claiming should too.
    if (!window.confirm(`Claim tile ${tile.position}? It takes one of your active slots.`)) return;

    setBusyTileId(tile.id);
    setNotice(null);
    try {
      await claimTile(tile.id);
      await game.refresh();
    } catch (err) {
      setNotice(err.message);
    } finally {
      setBusyTileId(null);
    }
  }

  const { loading, error, teams, myTeamId, myRole, tiles, myShipCells, myFleet, enemyShots, events, scores } = game;
  const maxActive = game.game?.max_active_tiles ?? 2;
  const activeCount = tiles.filter((t) => t.claim_status === 'active').length;
  const isActive = game.game?.status === 'active';
  const canClaim = isActive && Boolean(myTeamId) && activeCount < maxActive;

  return (
    <main className="app">
      <header className="top">
        <h1>HS Battleships</h1>
        <div className="who">
          <span className="name">{displayName || 'Signed in'}</span>
          <button className="link" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </header>

      {/* An admin has no team, so the player view would show them an empty
          board and a claim button that cannot work. They get the organiser's
          console instead, which carries its own both-boards overview. */}
      {isAdmin && <Admin />}

      {!isAdmin && <>
      {loading && <p>Loading game…</p>}
      {error && <p className="error">{error}</p>}
      {notice && <p className="error">{notice}</p>}

      {!loading && !game.game && <p>No game yet. An admin needs to create one.</p>}

      {waitingForTeam && (
        <section className="card waiting">
          <p className="lead">
            You are not assigned to a team yet.<br />
            Come back once teams have been made.
          </p>
          <p className="muted">
            Signed in as <strong>{displayName}</strong> — this page will let you
            in on its own once an admin adds you.
          </p>
        </section>
      )}

      {game.game && !waitingForTeam && (
        <>
          <p className="status">
            <strong>{game.game.name}</strong> — {game.game.status}
            {myTeamId && ` · you play for ${teams.find((t) => t.id === myTeamId)?.name}`}
          </p>

          {game.game.status === 'finished' && (
            <p className="banner">
              {teams.find((t) => t.id === game.game.winner_team_id)?.name} wins.
            </p>
          )}

          {game.game.status === 'placement' && myTeamId && (
            <CaptainPlacement
              isCaptain={myRole === 'captain'}
              teamId={myTeamId}
              teamName={teams.find((t) => t.id === myTeamId)?.name ?? 'your'}
              fleet={game.game.fleet}
              shipsPlaced={myFleet.length}
              onPlaced={() => game.refresh()}
            />
          )}

          <Scoreboard scores={scores} myTeamId={myTeamId} game={game.game} />

          <div className="columns">
            <section>
              <h2>Enemy waters</h2>
              <EnemyGrid
                tiles={tiles}
                onClaim={onClaim}
                canClaim={canClaim}
                busyTileId={busyTileId}
              />
              {isActive && !canClaim && myTeamId && (
                <p className="muted">Both slots are full — fire one before claiming another.</p>
              )}
            </section>

            <section>
              <h2>Your fleet</h2>
              <MyFleet
                myShipCells={myShipCells}
                enemyShots={enemyShots}
                tiles={tiles}
                fleet={myFleet}
              />
            </section>
          </div>

          <ActiveTiles
            tiles={tiles}
            maxActive={maxActive}
            onFired={(tile, result) => {
              setNotice(`${tile.name} — ${result.toUpperCase()}!`);
              game.refresh();
            }}
          />

          <EventFeed events={events} teams={teams} myTeamId={myTeamId} />
        </>
      )}
      </>}
    </main>
  );
}
