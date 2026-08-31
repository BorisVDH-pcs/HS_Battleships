import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase.js';

/**
 * Loads everything the board needs for one game and keeps it live.
 *
 * Realtime on `game_events` is the trigger to refetch: every meaningful change
 * (claim, shot, sinking, win) writes an event, so one subscription covers the
 * whole game. That replaces the Apps Script's 120-second polling loop.
 */
export function useGame(gameId, session) {
  const [state, setState] = useState({
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
  });

  const load = useCallback(async () => {
    if (!supabase || !gameId || !session) return;
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
      setState((s) => ({ ...s, loading: false, error: err.message }));
    }
  }, [gameId, session]);

  useEffect(() => {
    load();
  }, [load]);

  // One subscription for the whole game.
  useEffect(() => {
    if (!supabase || !gameId) return;
    const channel = supabase
      .channel(`game:${gameId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'game_events', filter: `game_id=eq.${gameId}` },
        () => load()
      )
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [gameId, load]);

  return { ...state, refresh: load };
}
