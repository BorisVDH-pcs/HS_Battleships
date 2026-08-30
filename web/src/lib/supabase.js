// Supabase client. Unlike HighSocietyScape (which uses a bare fetch wrapper with
// the anon key and no sign-in), Battleships needs real per-user auth and
// Realtime, so it uses the official SDK.
//
// The anon key is safe in the browser: RLS decides what it can read, and every
// write goes through a `security definer` RPC. See docs/architecture.md.

import { createClient } from '@supabase/supabase-js';

const URL = import.meta.env.VITE_SUPABASE_URL;
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(URL && ANON);

if (!isSupabaseConfigured) {
  console.warn(
    'Supabase is not configured. Copy .env.example to web/.env and fill in ' +
      'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'
  );
}

export const supabase = isSupabaseConfigured
  ? createClient(URL, ANON)
  : null;

// ---- Game API ------------------------------------------------------------
// These four are the entire write surface (see supabase/migrations/0002_rpc.sql).

export async function placeFleet(teamId, ships) {
  const { error } = await supabase.rpc('place_fleet', {
    p_team_id: teamId,
    p_ships: ships,
  });
  if (error) throw new Error(error.message);
}

export async function startGame(gameId) {
  const { error } = await supabase.rpc('start_game', { p_game_id: gameId });
  if (error) throw new Error(error.message);
}

export async function claimTile(tileId) {
  const { data, error } = await supabase.rpc('claim_tile', { p_tile_id: tileId });
  if (error) throw new Error(error.message);
  return data;
}

/** Returns 'hit' or 'miss' immediately — no polling, unlike the Sheets version. */
export async function fireTile(claimId) {
  const { data, error } = await supabase.rpc('fire_tile', { p_claim_id: claimId });
  if (error) throw new Error(error.message);
  return data;
}

// ---- Admin API -----------------------------------------------------------
// Every one of these re-checks is_admin() server-side, so hiding the admin tab
// in the UI is a convenience, never the control.

async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

export const adminCreateGame = (name, teamA, teamB, gridSize = 10, maxActive = 2) =>
  rpc('admin_create_game', {
    p_name: name, p_team_a: teamA, p_team_b: teamB,
    p_grid_size: gridSize, p_max_active: maxActive,
  });

/** tiles: [{ row, col, name, rules }] — must be exactly gridSize^2 of them. */
export const adminSetTiles = (gameId, tiles) =>
  rpc('admin_set_tiles', { p_game_id: gameId, p_tiles: tiles });

export const adminSetMember = (teamId, profileId, role) =>
  rpc('admin_set_member', { p_team_id: teamId, p_profile_id: profileId, p_role: role });

export const adminRemoveMember = (teamId, profileId) =>
  rpc('admin_remove_member', { p_team_id: teamId, p_profile_id: profileId });

export const adminOpenPlacement = (gameId) =>
  rpc('admin_open_placement', { p_game_id: gameId });

export const adminListTiles = (gameId) =>
  rpc('admin_list_tiles', { p_game_id: gameId });

export const adminListShipCells = (gameId) =>
  rpc('admin_list_ship_cells', { p_game_id: gameId });

export const adminDeleteGame = (gameId) =>
  rpc('admin_delete_game', { p_game_id: gameId });

// ---- Scoring -------------------------------------------------------------
// Totals are derived (see the `team_scores` function); these only touch the manual
// adjustments layered on top, which is the sheet's "+1" button.

/** `reason` is required and is visible to this team and admins, never to the enemy. */
export const adminAdjustScore = (teamId, delta, reason, profileId = null) =>
  rpc('admin_adjust_score', {
    p_team_id: teamId, p_delta: delta, p_reason: reason, p_profile_id: profileId,
  });

export const adminListScoreEvents = (gameId) =>
  rpc('admin_list_score_events', { p_game_id: gameId });

export const adminDeleteScoreEvent = (id) =>
  rpc('admin_delete_score_event', { p_id: id });

export const adminSetScoring = (gameId, perTile, perHit, perSink) =>
  rpc('admin_set_scoring', {
    p_game_id: gameId, p_per_tile: perTile, p_per_hit: perHit, p_per_sink: perSink,
  });
