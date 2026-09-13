import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase.js';
import { subscribeToGameEvents } from '../lib/gameEvents.js';
import { REVEAL_DELAY_MS } from '../lib/fireEffect.js';

// Spreads the refetch that answers an event across a window, instead of every
// open board firing it on the same millisecond.
//
// One game_events row reaches all fifty players at once, and each board answers
// it with the ten queries in `load` below -- five hundred requests through
// PostgREST's pool in a single instant. `shot_fired` is the worst of it:
// REVEAL_DELAY_MS is a constant, so every client wakes on exactly the same tick
// rather than merely near it. A random offset turns that spike into a ramp.
//
// Nobody waits longer for their own action. onClaim awaits `refresh` directly
// once claimTile resolves, so the acting player's board updates immediately and
// only the watching boards are staggered; the cannon animation is untouched too,
// since FireEffect runs off App's own `shots:` channel rather than this timer.
const JITTER_MS = 800;
const jitter = () => Math.random() * JITTER_MS;

const BLANK = {
  loading: true,
  error: null,
  game: null,
  teams: [],
  myTeamId: null,
  myRole: null,     // 'captain' lets this player place the team's fleet
  tiles: [],        // tiles_for_me: name is null until my team claims it
  myShipCells: [],  // my own placement (RLS hides the enemy's)
  myFleet: [],      // ship_status for my fleet only
  enemyShots: [],   // fired claims by the other team, onto my board
  events: [],
  scores: [],       // team_scores: derived totals for BOTH teams, no free text
  evidence: [],     // my_evidence: my team's uploads, keyed to claims
};

/**
 * Loads everything the board needs for one game and keeps it live.
 *
 * Realtime on `game_events` is the trigger to refetch: every meaningful change
 * (claim, shot, sinking, win) writes an event, so one subscription covers the
 * whole game. That replaces the Apps Script's 120-second polling loop.
 */
export function useGame(gameId, session) {
  const [state, setState] = useState(BLANK);
  // Whether the board on screen is still hearing about the game.
  //
  //   'connecting' — opening, or reopening after a drop. Says nothing yet.
  //   'live'       — subscribed; every change arrives as it happens.
  //   'offline'    — the channel failed. The board is as stale as the last
  //                  successful load, and the poll below is all that moves it.
  const [live, setLive] = useState('connecting');

  // Bumped on every load. A switch fires a second load while the first is still
  // in flight, and the two can come back in either order -- on a phone on event
  // wifi, routinely the wrong one. Without this, a slow reply for the game just
  // left repaints its tiles over the game now on screen, and `loading` goes
  // false, so it looks settled and correct.
  const loadSeq = useRef(0);
  // The game currently being shown, as opposed to the one a given `load` call
  // closed over. `refresh` is handed out to callers -- onClaim awaits it after
  // claimTile resolves -- so a call started before a switch can still be in
  // flight after it, holding the previous gameId. The sequence number alone
  // does not catch that: the stale call bumps it too, then passes its own
  // check and paints the game just left over the one now on screen.
  const shownId = useRef(gameId);
  shownId.current = gameId;

  const uid = session?.user?.id ?? null;

  const load = useCallback(async () => {
    if (!supabase || !gameId || !uid) return;
    const seq = ++loadSeq.current;
    try {
      // One request for the whole board, where this used to make ten: three to
      // work out which team the player is on, five for the board, then evidence
      // and the enemy's shots. Every open board repeated the set on every event.
      //
      // board_for_me is `security invoker`, so each table it reads is still
      // filtered by exactly the RLS policies these queries passed through when
      // they were separate requests -- the function cannot widen what a player
      // sees. tiles_for_me, team_scores and my_evidence are called inside it as
      // the `security definer` functions they already were.
      const { data, error } = await supabase.rpc('board_for_me', { p_game_id: gameId });
      if (error) throw new Error(error.message);
      const board = data ?? {};

      const teams = board.teams ?? [];
      const memberships = board.memberships ?? [];
      const myTeamId =
        teams.find((t) => memberships.some((m) => m.team_id === t.id))?.id ?? null;
      // Captains may place their own fleet — place_fleet() has always allowed it.
      const myRole = memberships.find((m) => m.team_id === myTeamId)?.role ?? null;

      if (seq !== loadSeq.current || gameId !== shownId.current) return;
      setState({
        loading: false,
        error: null,
        game: board.game ?? null,
        teams,
        myTeamId,
        myRole,
        tiles: board.tiles ?? [],
        myShipCells: board.myShipCells ?? [],
        myFleet: board.myFleet ?? [],
        enemyShots: board.enemyShots ?? [],
        events: board.events ?? [],
        scores: board.scores ?? [],
        evidence: board.evidence ?? [],
      });
    } catch (err) {
      if (seq !== loadSeq.current || gameId !== shownId.current) return;
      setState((s) => ({ ...s, loading: false, error: err.message }));
    }
    // Keyed on the user id rather than the session object. The board needs only
    // who the player is -- the server reads auth.uid() for itself now -- and a
    // plain string cannot churn the way a re-emitted session object can.
  }, [gameId, uid]);

  // Clear the board the moment the game changes, ahead of the refetch.
  //
  // `load` is async and only calls setState when it returns, so without this
  // the previous game's tiles stay on screen -- with `loading` false -- under
  // the new game's name. That is not just untidy: the squares are live, and a
  // click landing in that window would call claimTile() with a tile id from
  // the game the player just left, spending an active slot over there.
  //
  // Keyed on gameId alone, so `refresh` after a claim still updates in place
  // rather than flashing the board empty on every action.
  const firstLoad = useRef(true);
  useEffect(() => {
    if (firstLoad.current) { firstLoad.current = false; return; }
    setState(BLANK);
  }, [gameId]);

  useEffect(() => {
    load();
  }, [load]);

  // One subscription for the whole game.
  //
  // `shot_fired` is held back by REVEAL_DELAY_MS so the tile flip and the
  // activity-log line land at the same instant FireEffect.jsx starts the
  // hit/miss sound — after the cannon gif finishes and its post-gif pause,
  // not while the gif is still playing.
  // Every other event type (claims, sinkings, wins…) has no animation to
  // wait on, so it refetches immediately.
  //
  // The status callback is the difference between a live board and one that
  // has quietly stopped being live. Everything on this page arrives through
  // this one channel, so when it drops the board keeps showing the last state
  // it saw — correct-looking, wrong, and with nothing on screen to say so. A
  // player on event wifi loses this socket routinely; before, the only way
  // back was knowing to reload a page that looked fine.
  //
  // SUBSCRIBED refetches rather than merely clearing the flag: a reconnect
  // means the gap is over, not that nothing happened during it, and every
  // event that fired while the socket was down was missed for good. That also
  // covers the first connect, at the cost of one extra load on mount.
  //
  // CLOSED is deliberately not treated as a fault. It arrives once per mount
  // under StrictMode and again on every teardown, so reading it as "offline"
  // would light the warning during an ordinary game switch.
  const pendingTimers = useRef([]);
  useEffect(() => {
    if (!supabase || !gameId) return undefined;
    // Guards the callback against a reply arriving after this effect has been
    // torn down — a game switch tears the old channel down while its own
    // status events are still in flight.
    let current = true;
    setLive('connecting');
    const unsubscribe = subscribeToGameEvents(
      gameId,
      (row) => {
        // Tracked so a game switch cancels a refetch still waiting out its
        // offset -- it would otherwise land against the game just left. Each
        // timer drops itself once it has fired: every event waits now, not
        // just the occasional shot, so a list that only emptied on teardown
        // would grow for the length of the game.
        const schedule = (delay) => {
          const id = setTimeout(() => {
            pendingTimers.current = pendingTimers.current.filter((t) => t !== id);
            load();
          }, delay);
          pendingTimers.current.push(id);
        };
        schedule(row?.type === 'shot_fired' ? REVEAL_DELAY_MS + jitter() : jitter());
      },
      (status) => {
        if (!current) return;
        if (status === 'SUBSCRIBED') { setLive('live'); load(); }
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setLive('offline');
      }
    );
    return () => {
      current = false;
      unsubscribe();
      pendingTimers.current.forEach(clearTimeout);
      pendingTimers.current = [];
    };
  }, [gameId, load]);

  // Coming back to the tab refetches the game, the way App already refetches
  // the roster. Between them these cover the two ways a board goes stale
  // without the socket ever reporting an error: a phone that slept through a
  // shot, and a laptop lid closed over one.
  //
  // Throttled on the same 1.5s as the roster's own recheck, because returning
  // to a tab fires `focus` and `visibilitychange` together and both have to
  // stay — only one covers a phone unlocking, only the other a desktop
  // alt-tab.
  const recheckAt = useRef(0);
  useEffect(() => {
    if (!gameId) return undefined;
    const recheck = () => {
      if (document.hidden) return;
      if (Date.now() - recheckAt.current < 1500) return;
      recheckAt.current = Date.now();
      load();
    };
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', recheck);
    return () => {
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', recheck);
    };
  }, [gameId, load]);

  // A slow poll for as long as the socket is down, so a board that cannot hear
  // events still moves. Only while disconnected: with the channel up every
  // change already arrives, and polling on top of it would be the 120-second
  // Apps Script loop this replaced. AdminOverview polls unconditionally for a
  // different reason — uploads write no game_event, so its evidence counts
  // have nothing to listen to.
  useEffect(() => {
    if (!gameId || live === 'live') return undefined;
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [gameId, live, load]);

  return { ...state, live, refresh: load };
}
