import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase.js';
import { REVEAL_DELAY_MS } from '../lib/fireEffect.js';

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

  const load = useCallback(async () => {
    if (!supabase || !gameId || !session) return;
    const seq = ++loadSeq.current;
    try {
      const uid = session.user.id;

      const [{ data: game }, { data: teams }, { data: memberships }] = await Promise.all([
        supabase.from('games').select('*').eq('id', gameId).single(),
        supabase.from('teams').select('*').eq('game_id', gameId).order('name'),
        supabase.from('team_members').select('team_id, role').eq('profile_id', uid),
      ]);

      const myTeamId =
        teams?.find((t) => memberships?.some((m) => m.team_id === t.id))?.id ?? null;
      // Captains may place their own fleet — place_fleet() has always allowed it.
      const myRole = memberships?.find((m) => m.team_id === myTeamId)?.role ?? null;
      const enemyTeamId = teams?.find((t) => t.id !== myTeamId)?.id ?? null;

      const [
        { data: tiles }, { data: myShipCells }, { data: myFleet },
        { data: events }, { data: scores },
      ] = await Promise.all([
        // tiles_for_me and team_scores are `security definer` FUNCTIONS, not
        // views — see 0010. They already order their own rows.
        supabase.rpc('tiles_for_me', { p_game_id: gameId }),
        // RLS already limits both to my own teams, but "my teams" spans every
        // game I have ever been in. Without the filter a second game would draw
        // the other game's ships onto this board, and miscount shipsPlaced.
        myTeamId
          ? supabase.from('ship_cells').select('*').eq('team_id', myTeamId)
          : supabase.from('ship_cells').select('*'),
        // Team-filtered for the same reason, and it is the stricter of the two:
        // ship_status carries one row per ship, so a player sitting in both
        // teams of this game counted ten hulls afloat against a five-ship
        // fleet. The cells above hid it whenever the two fleets overlapped.
        myTeamId
          ? supabase.from('ship_status').select('*').eq('game_id', gameId).eq('team_id', myTeamId)
          : supabase.from('ship_status').select('*').eq('game_id', gameId),
        supabase
          .from('game_events')
          .select('*')
          .eq('game_id', gameId)
          .order('created_at', { ascending: false })
          .limit(50),
        supabase.rpc('team_scores', { p_game_id: gameId }),
      ]);

      // Evidence is team-scoped by the function itself, so it needs no filter
      // here — but it does need the game id, or a second game's uploads would
      // appear against this board's claims.
      const { data: evidence } = await supabase.rpc('my_evidence', { p_game_id: gameId });

      // Enemy shots land on my board: their fired claims, resolved to coordinates.
      let enemyShots = [];
      if (enemyTeamId) {
        const { data } = await supabase
          .from('tile_claims')
          .select('tile_id, result, status')
          .eq('team_id', enemyTeamId)
          .eq('status', 'fired');
        enemyShots = data ?? [];
      }

      if (seq !== loadSeq.current || gameId !== shownId.current) return;
      setState({
        loading: false,
        error: null,
        game: game ?? null,
        teams: teams ?? [],
        myTeamId,
        myRole,
        tiles: tiles ?? [],
        myShipCells: myShipCells ?? [],
        myFleet: myFleet ?? [],
        enemyShots,
        events: events ?? [],
        scores: scores ?? [],
        evidence: evidence ?? [],
      });
    } catch (err) {
      if (seq !== loadSeq.current || gameId !== shownId.current) return;
      setState((s) => ({ ...s, loading: false, error: err.message }));
    }
  }, [gameId, session]);

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
    const channel = supabase
      .channel(`game:${gameId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'game_events', filter: `game_id=eq.${gameId}` },
        ({ new: row }) => {
          if (row?.type === 'shot_fired') {
            pendingTimers.current.push(setTimeout(load, REVEAL_DELAY_MS));
          } else {
            load();
          }
        }
      )
      .subscribe((status) => {
        if (!current) return;
        if (status === 'SUBSCRIBED') { setLive('live'); load(); }
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setLive('offline');
      });
    return () => {
      current = false;
      supabase.removeChannel(channel);
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
