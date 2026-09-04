import { useCallback, useEffect, useRef, useState } from 'react';
import Guide from './components/Guide.jsx';
import { supabase, isSupabaseConfigured, claimTile } from './lib/supabase.js';
import { useGame } from './hooks/useGame.js';
import { coordLabel, fromPosition, sunkShipIds } from './lib/board.js';
import Login from './components/Login.jsx';
import EnemyGrid from './components/EnemyGrid.jsx';
import MyFleet from './components/MyFleet.jsx';
import ActiveTiles from './components/ActiveTiles.jsx';
import FireEffect from './components/FireEffect.jsx';
import EventFeed from './components/EventFeed.jsx';
import CaptainPlacement from './components/CaptainPlacement.jsx';
import Admin from './components/Admin.jsx';
import TeamNameEditor from './components/TeamNameEditor.jsx';
import Wordmark from './components/Wordmark.jsx';
import EvidencePanel from './components/EvidencePanel.jsx';
import BoardLegend from './components/BoardLegend.jsx';
import PetJar from './components/PetJar.jsx';
import StatsPanel from './components/StatsPanel.jsx';
import { useConfirm } from './components/ConfirmDialog.jsx';
import GamePicker from './components/GamePicker.jsx';
import { listMyGames, readGamePick, writeGamePick } from './lib/games.js';
import { statusLabel } from './lib/status.js';
import { REVEAL_DELAY_MS } from './lib/fireEffect.js';

export default function App() {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);
  const [gameId, setGameId] = useState(null);
  // Every game this player is rostered into. Empty for an admin, and for a
  // signup no captain has picked yet -- both fall back below.
  const [myGames, setMyGames] = useState([]);
  const [notice, setNotice] = useState(null);
  const [shot, setShot] = useState(null);
  const [busyTileId, setBusyTileId] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  // Which board is on screen. The two used to sit side by side, which cost
  // each of them half the page and left the cells too small to read the tile
  // art in. One at a time, full width.
  const [boardTab, setBoardTab] = useState('enemy');
  // A locked-in square the team has pressed to re-read its evidence. Held as an
  // id rather than the row, so it survives a refresh of the tile list.
  const [openTileId, setOpenTileId] = useState(null);
  // Above the early returns below, with the rest of the hooks — useConfirm
  // holds state of its own.
  const [confirm, confirmDialog] = useConfirm();
  const guideRef = useRef(null);

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

  const uid = session?.user?.id ?? null;

  // The chosen game, mirrored so the roster refresh can read it without taking
  // it as a dependency -- which would rebuild the refresh on every switch.
  const gameIdRef = useRef(null);
  gameIdRef.current = gameId;
  // Bumped per roster read, so an alt-tab storm cannot let a slow earlier reply
  // land on top of a newer one.
  const gamesSeq = useRef(0);
  // Returning to the tab fires `focus` and `visibilitychange` together, and
  // both need to stay: only `visibilitychange` covers a phone unlocking, only
  // `focus` covers a desktop alt-tab, where the page never became hidden.
  // Collapsing the overlap here is cheaper than dropping either one.
  const gamesAt = useRef(0);

  // Which game to show.
  //
  // Rostered players get their own games, newest first, with their last pick
  // restored. Everyone else keeps the original behaviour -- newest game that
  // exists, membership or not -- and that fallback is load-bearing twice over:
  //
  //   * an admin has no team, and `gameId` also drives the shot-sound channel
  //     below, which sits outside the isAdmin split on purpose so the organiser
  //     hears cannons land. Filtering it to "my games" would silence them;
  //   * `waitingForTeam` needs a game to be loaded before it will show the
  //     waiting room. With no gameId a fresh signup gets "No game yet. An admin
  //     needs to create one." instead -- true of nobody, and alarming.
  const loadGames = useCallback(async ({ throttle = false } = {}) => {
    if (!supabase || !uid) return;
    if (throttle && Date.now() - gamesAt.current < 1500) return;
    gamesAt.current = Date.now();
    const seq = ++gamesSeq.current;

    let mine = [];
    try {
      mine = await listMyGames(uid);
    } catch {
      // A failed roster read should not black out the board. Fall through to
      // the newest-game query, which is what this page did before the picker.
      mine = [];
    }
    if (seq !== gamesSeq.current) return;
    setMyGames(mine);

    if (mine.length > 0) {
      // Re-runs must not move a player who is already somewhere valid. This is
      // the guard that makes the refresh below safe to fire on every alt-tab,
      // and it is what keeps a player put when localStorage is unavailable --
      // in a private window `readGamePick` always returns null, so without it
      // every refresh would snap them back to the newest game mid-match.
      if (mine.some((g) => g.gameId === gameIdRef.current)) return;

      // A stored pick can name a game since deleted from the admin console, so
      // it is only honoured if it is still in the list.
      const saved = readGamePick(uid);
      const pick = mine.some((g) => g.gameId === saved) ? saved : mine[0].gameId;
      writeGamePick(uid, pick);
      setGameId(pick);
      return;
    }

    const { data } = await supabase
      .from('games')
      .select('id')
      .order('created_at', { ascending: false })
      .limit(1);
    if (seq !== gamesSeq.current) return;
    setGameId(data?.[0]?.id ?? null);
  }, [uid]);

  useEffect(() => {
    // Signed out, or swapped for another player on a shared phone: drop the
    // previous roster rather than briefly offering it to whoever is next.
    if (!uid) { setMyGames([]); setGameId(null); return; }
    loadGames();
  }, [uid, loadGames]);

  // Nothing writes a game_event when a captain adds a player, renames a game or
  // deletes one, so the Realtime subscription never hears about any of it. A
  // player coming back to the tab is the cheap moment to re-check: it catches
  // the game they were just added to, and moves them off one that has been
  // deleted under them.
  useEffect(() => {
    if (!uid) return undefined;
    const recheck = () => { if (!document.hidden) loadGames({ throttle: true }); };
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', recheck);
    return () => {
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', recheck);
    };
  }, [uid, loadGames]);

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

  // A cannon fire is not a private event — every `shot_fired` row is
  // world-readable (see 0039's `events_read` policy), so anyone with the
  // page open, admins and teamless spectators included, should hear it the
  // moment it lands rather than only the team that pulled the trigger.
  useEffect(() => {
    if (!supabase || !gameId) return undefined;
    const channel = supabase
      .channel(`shots:${gameId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'game_events', filter: `game_id=eq.${gameId}` },
        ({ new: row }) => {
          if (row.type !== 'shot_fired') return;
          setShot({ nonce: Date.now(), result: row.payload?.result });
        }
      )
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [gameId]);

  // Signed up, but no captain has picked them yet. Showing the board here would
  // be a game they cannot touch, with the reason buried in a grey clause — so
  // they get a waiting room instead.
  const waitingForTeam =
    !isAdmin && !game.loading && Boolean(game.game) && !game.myTeamId;

  // Being added to a team writes no game_event, so the Realtime subscription
  // never fires for it. Poll while waiting so the page lets them in by itself
  // rather than needing to be told to refresh. Must sit above the early returns
  // below — a hook after a conditional return is a hook that sometimes vanishes.
  //
  // The roster read goes with it: a captain may well add this player to an
  // older game rather than the newest one on screen, and refreshing only the
  // game being watched would leave them in the waiting room staring at a game
  // they were never going to be in.
  const refreshRef = useRef(game.refresh);
  refreshRef.current = game.refresh;
  useEffect(() => {
    if (!waitingForTeam) return undefined;
    const id = setInterval(() => {
      refreshRef.current?.();
      loadGames();
    }, 10000);
    return () => clearInterval(id);
  }, [waitingForTeam, loadGames]);

  if (!isSupabaseConfigured) {
    return (
      <main className="app">
        <Wordmark />
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
    // A grid cell is a small target, especially on a phone, and locking a tile
    // in is not free: it takes one of the team's active slots until the tile is
    // fired. Firing already confirms in ActiveTiles; locking in should too.
    const { row, col } = fromPosition(tile.position);
    if (!(await confirm(
      `Lock in ${coordLabel(row, col)}? It takes one of your active slots.`,
      { title: `Lock in ${coordLabel(row, col)}`, confirmLabel: 'Lock it in' }
    ))) return;

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

  // Moving to another game. Four pieces of state below are keyed to the board
  // being left, and none of them survive the move meaningfully:
  //
  //   shot        -- would fire a cannon and a hit sound for the other game;
  //   openTileId  -- a tile id from the old board, so the evidence panel would
  //                  open on a square that is not there;
  //   busyTileId  -- leaves a square spinning forever, nothing will clear it;
  //   notice      -- an error about a game no longer on screen.
  //
  // useGame needs no help: `load` is keyed on gameId and the channel cleanup
  // clears its pending reveal timers.
  function switchGame(nextId) {
    if (!nextId || nextId === gameId) return;
    setShot(null);
    setOpenTileId(null);
    setBusyTileId(null);
    setNotice(null);
    setBoardTab('enemy');
    writeGamePick(uid, nextId);
    setGameId(nextId);
  }

  const { loading, error, teams, myTeamId, myRole, tiles, myShipCells, myFleet, enemyShots, events, evidence } = game;
  const maxActive = game.game?.max_active_tiles ?? 2;
  const activeCount = tiles.filter((t) => t.claim_status === 'active').length;
  const isActive = game.game?.status === 'active';
  // The database enum still calls this phase `placement`; the players call it
  // preparation. Renaming the value itself would break every guard that
  // compares against the string, so the rename is in the words, not the schema.
  const isPreparation = game.game?.status === 'placement';
  const isFinished = game.game?.status === 'finished';
  const canClaim = isActive && Boolean(myTeamId) && activeCount < maxActive;
  const myTeam = teams.find((t) => t.id === myTeamId) ?? null;
  // ship_status.sunk is always false when a player reads it, so this counted
  // an intact fleet however much of it was on the bottom - see sunkShipIds.
  // myFleet is still the source of how many hulls there are; only its damage
  // columns are unreadable from here.
  const sunkCount = sunkShipIds(myShipCells, enemyShots, tiles).size;
  // Re-read from `tiles` so the panel's counts follow a refresh rather than
  // freezing at whatever they were when the square was pressed.
  const openTile = tiles.find((t) => t.id === openTileId && t.revealed) ?? null;

  return (
    <main className="app">
      <header className="top" id="app-header">
        <Wordmark />
        <div className="who">
          <span className="name">{displayName || 'Signed in'}</span>
          {!isAdmin && (
            <button className="link" onClick={() => guideRef.current?.openWelcome()}>
              📖 How to Play
            </button>
          )}
          <button className="link" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </header>

      {!isAdmin && (
        <Guide
          ref={guideRef}
          autoShow={!loading && Boolean(game.game) && !waitingForTeam}
          onTabNeed={setBoardTab}
        />
      )}

      {/* An admin has no team, so the player view would show them an empty
          board and a lock-in button that cannot work. They get the organiser's
          console instead, which carries its own both-boards overview. */}
      {isAdmin && <Admin />}

      {/* Outside the admin/player split on purpose: an admin has no team but
          still has the page open, and should hear a shot land same as
          anyone else. */}
      <FireEffect shot={shot} />

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
            <GamePicker
              games={myGames}
              gameId={gameId}
              onPick={switchGame}
              fallbackName={game.game.name}
            />{' '}
            — {statusLabel(game.game.status)}
            {myTeamId && ` · you play for ${teams.find((t) => t.id === myTeamId)?.name}`}
          </p>

          {game.game.status === 'finished' && (
            <p className="banner">
              {teams.find((t) => t.id === game.game.winner_team_id)?.name} wins.
            </p>
          )}

          {/* Prep only, and first: naming the team is the opening move, and
              once the game starts the name is settled. An admin can still
              rename either team from the console if one has to be fixed
              mid-event — rename_team itself has no phase guard. */}
          {isPreparation && myRole === 'captain' && myTeam && (
            <section className="card">
              <h2>Your team</h2>
              <TeamNameEditor team={myTeam} onRenamed={() => game.refresh()} />
            </section>
          )}

          {isPreparation && myTeamId && (
            <CaptainPlacement
              isCaptain={myRole === 'captain'}
              teamId={myTeamId}
              teamName={myTeam?.name ?? 'your'}
              fleet={game.game.fleet}
              shipsPlaced={myFleet.length}
              onPlaced={() => game.refresh()}
            />
          )}

          {/* No board layout to sit beside yet, so full width same as always.
              Once the boards appear the feed moves into the left column. */}
          {isPreparation && <EventFeed events={events} teams={teams} myTeamId={myTeamId} />}

          {/* Nothing here means anything until the game starts: there is no
              enemy to shoot at, your own fleet is the thing you are still
              arranging above, and no tile can be locked in yet. Showing all
              three during preparation left the placement board sharing the
              screen with two boards that could only say "not yet", and pushed
              the one thing a captain has to do off the top. */}
          {!isPreparation && (
          <section className="boards">
            <div className="board-layout">
              {/* Stats sit above the activity feed in the same left-hand
                  column: read-only context first, then the scrolling log
                  underneath it, height-capped so a long game doesn't grow
                  the page underneath it. */}
              <div className="feed-col">
                <StatsPanel gameId={gameId} teams={teams} myTeamId={myTeamId} />
                <EventFeed events={events} teams={teams} myTeamId={myTeamId} />
              </div>

              <div className="board-col">
                {/* The same tab strip the admin console uses, so this reads as
                    part of the app rather than a second idea about tabs. */}
                <div className="tabs board-tabs" id="board-tabs-row">
                  <button
                    className={boardTab === 'enemy' ? 'on' : ''}
                    onClick={() => setBoardTab('enemy')}
                  >
                    Enemy waters
                  </button>
                  <button
                    className={boardTab === 'fleet' ? 'on' : ''}
                    onClick={() => setBoardTab('fleet')}
                  >
                    Your fleet
                  </button>
                  {boardTab === 'fleet' && (
                    <span className="fleet-status">
                      {myFleet.length - sunkCount} afloat, {sunkCount} sunk
                    </span>
                  )}
                </div>

                {boardTab === 'enemy' ? (
                  <div id="enemy-board-section">
                    <EnemyGrid
                      tiles={tiles}
                      onClaim={onClaim}
                      onInspect={(tile) =>
                        setOpenTileId((id) => (id === tile.id ? null : tile.id))}
                      openTileId={openTileId}
                      canClaim={canClaim}
                      busyTileId={busyTileId}
                    />
                    <BoardLegend view="enemy" />
                    {isActive && !canClaim && myTeamId && (
                      <p className="muted">Both slots are full — fire one before locking in another.</p>
                    )}
                    {openTile && (
                      <EvidencePanel
                        title={openTile.name}
                        coord={coordLabel(
                          fromPosition(openTile.position).row,
                          fromPosition(openTile.position).col
                        )}
                        meta={
                          `${openTile.evidence_count} of ${openTile.required_evidence} submitted` +
                          (openTile.claim_status === 'fired'
                            ? ` · fired, ${openTile.claim_result}` +
                              (openTile.ship_sunk ? ' — ship sunk!' : '')
                            : ' · not yet fired')
                        }
                        items={evidence.filter((e) => e.claim_id === openTile.claim_id)}
                        onClose={() => setOpenTileId(null)}
                      />
                    )}
                  </div>
                ) : (
                  <div id="fleet-board-section">
                    <MyFleet
                      myShipCells={myShipCells}
                      enemyShots={enemyShots}
                      tiles={tiles}
                    />
                    <BoardLegend view="fleet" />
                  </div>
                )}
              </div>

              {/* The two slots are what a player checks and acts on most
                  often mid-game, so they sit at the very top of the column
                  beside the board rather than under the score. */}
              <div className="side-col">
                {/* Hidden once the game is finished. The slots carry working
                    upload controls, and a submit that completes a tile fires
                    the shot — so leaving them on screen after a result
                    invited a team to finish a tile it was still working on
                    and fire into a match that was already decided. 0027
                    refuses that server-side; this stops the page offering it
                    in the first place. */}
                {!isFinished && (
                  <ActiveTiles
                    tiles={tiles}
                    maxActive={maxActive}
                    gameId={gameId}
                    teamId={myTeamId}
                    evidence={evidence}
                    onRefresh={() => game.refresh()}
                    onFired={(tile, result) => {
                      // Sound/animation come from the realtime subscription
                      // above, not from here — but this client already knows
                      // the result, so an un-delayed refresh would color the
                      // tile and post the notice before its own gif/sound had
                      // even started. Wait out the same beat everyone else's
                      // realtime-triggered reveal does.
                      setTimeout(() => {
                        setNotice(`${tile.name} — ${result.toUpperCase()}!`);
                        game.refresh();
                      }, REVEAL_DELAY_MS);
                    }}
                  />
                )}

                {!isFinished && myTeamId && (
                  <PetJar
                    gameId={gameId}
                    teamId={myTeamId}
                    count={myTeam?.pet_jar_count ?? 0}
                    tiles={tiles}
                    onRefresh={() => game.refresh()}
                  />
                )}
              </div>
            </div>
          </section>
          )}
        </>
      )}
      </>}

      {/* Last in the tree and fixed-position, so it sits over whichever view is
          on screen — the admin console included. */}
      {confirmDialog}
    </main>
  );
}
