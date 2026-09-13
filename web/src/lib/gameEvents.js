// One Realtime subscription per game, shared by everything that watches it.
//
// Three places want the same rows: useGame refetches the board, App plays the
// cannon on a `shot_fired`, and useGameStats appends to its history. Each used
// to open a channel of its own with a byte-identical filter, and Realtime
// matches every subscription separately -- so one inserted row was delivered
// three times to every player. At fifty players that is a hundred and fifty
// messages for a single shot where fifty will do.
//
// They still need their own handlers, so the fan-out moves here: the row
// arrives once and is handed to each listener as a plain function call.
//
// Reference counted. The channel opens when the first listener arrives and
// closes only when the last one leaves, so switching games -- which unmounts
// these consumers in no guaranteed order -- cannot tear down a channel another
// one is still using.

import { supabase } from './supabase.js';

const entries = new Map(); // gameId -> { channel, listeners, statusListeners, lastStatus }

/**
 * Watch `game_events` inserts for one game.
 *
 * `onEvent(row)` gets every inserted row. `onStatus(status)` is optional and
 * receives the channel's subscribe status -- useGame needs it to drive the
 * live/offline badge and its fallback poll; the other two do not care.
 *
 * A listener joining an already-open channel is replayed the last status
 * immediately, because it would otherwise wait for the next reconnect to learn
 * a channel it is already attached to is live.
 *
 * Returns an unsubscribe function.
 */
export function subscribeToGameEvents(gameId, onEvent, onStatus) {
  if (!supabase || !gameId) return () => {};

  let entry = entries.get(gameId);

  if (!entry) {
    entry = { channel: null, listeners: new Set(), statusListeners: new Set(), lastStatus: null };
    entries.set(gameId, entry);
    entry.channel = supabase
      .channel(`game:${gameId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'game_events', filter: `game_id=eq.${gameId}` },
        ({ new: row }) => {
          // Copied before iterating: a handler may unsubscribe itself, and
          // mutating the Set mid-iteration would skip whoever came next.
          [...entry.listeners].forEach((fn) => fn(row));
        }
      )
      .subscribe((status) => {
        entry.lastStatus = status;
        [...entry.statusListeners].forEach((fn) => fn(status));
      });
  }

  entry.listeners.add(onEvent);
  if (onStatus) {
    entry.statusListeners.add(onStatus);
    if (entry.lastStatus) onStatus(entry.lastStatus);
  }

  return () => {
    entry.listeners.delete(onEvent);
    if (onStatus) entry.statusListeners.delete(onStatus);
    if (entry.listeners.size === 0 && entry.statusListeners.size === 0) {
      supabase.removeChannel(entry.channel);
      entries.delete(gameId);
    }
  };
}
