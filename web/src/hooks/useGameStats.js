import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase.js';

/**
 * The full event history for a game, separate from useGame's `events` (which
 * is capped at 50 rows for the activity feed). Stats need every row, so this
 * fetches once and then only ever appends — a Realtime insert adds the one
 * new row to local state rather than re-querying and re-deriving everything,
 * which is what keeps this cheap on a long game with a busy feed.
 */
export function useGameStats(gameId) {
  const [events, setEvents] = useState([]);
  const [profiles, setProfiles] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!supabase || !gameId) return;
    let cancelled = false;
    setLoading(true);

    Promise.all([
      supabase.from('game_events').select('*').eq('game_id', gameId).order('created_at'),
      supabase.from('profiles').select('id, display_name'),
    ]).then(([{ data: rows }, { data: people }]) => {
      if (cancelled) return;
      setEvents(rows ?? []);
      setProfiles(Object.fromEntries((people ?? []).map((p) => [p.id, p.display_name])));
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [gameId]);

  useEffect(() => {
    if (!supabase || !gameId) return;
    const channel = supabase
      .channel(`stats:${gameId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'game_events', filter: `game_id=eq.${gameId}` },
        (payload) => setEvents((prev) => (
          prev.some((e) => e.id === payload.new.id) ? prev : [...prev, payload.new]
        ))
      )
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [gameId]);

  // Stable across renders that don't touch `events`/`profiles`, which is the
  // point — a stats card recomputing on every unrelated tick is exactly what
  // the README flagged as the trap to avoid.
  return useMemo(() => ({ events, profiles, loading }), [events, profiles, loading]);
}
