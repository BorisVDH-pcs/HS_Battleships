import { useEffect, useState } from 'react';
import { supabase, isSupabaseConfigured, claimTile } from './lib/supabase.js';
import { useGame } from './hooks/useGame.js';
import Login from './components/Login.jsx';
import EnemyGrid from './components/EnemyGrid.jsx';
import MyFleet from './components/MyFleet.jsx';
import ActiveTiles from './components/ActiveTiles.jsx';
import EventFeed from './components/EventFeed.jsx';
import Admin from './components/Admin.jsx';

export default function App() {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);
  const [gameId, setGameId] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busyTileId, setBusyTileId] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [tab, setTab] = useState('game');

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

  const { loading, error, teams, myTeamId, tiles, myShipCells, myFleet, enemyShots, events } = game;
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

      {isAdmin && (
        <nav className="tabs">
          <button className={tab === 'game' ? 'on' : ''} onClick={() => setTab('game')}>Game</button>
          <button className={tab === 'admin' ? 'on' : ''} onClick={() => setTab('admin')}>Admin</button>
        </nav>
      )}

      {isAdmin && tab === 'admin' && <Admin />}

      {tab === 'game' && <>
      {loading && <p>Loading game…</p>}
      {error && <p className="error">{error}</p>}
      {notice && <p className="error">{notice}</p>}

      {!loading && !game.game && <p>No game yet. An admin needs to create one.</p>}

      {game.game && (
        <>
          <p className="status">
            <strong>{game.game.name}</strong> — {game.game.status}
            {myTeamId && ` · you play for ${teams.find((t) => t.id === myTeamId)?.name}`}
            {!myTeamId && ' · you are not on a team in this game'}
          </p>

          {game.game.status === 'finished' && (
            <p className="banner">
              {teams.find((t) => t.id === game.game.winner_team_id)?.name} wins.
            </p>
          )}

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
