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

/**
 * "We finished this by the short route." Only tiles the organiser flagged as
 * having more than one route accept this, and only with at least one screenshot
 * already submitted — both refused server-side, in complete_tile_early (0025).
 * Returns `{ fired, result, evidence_count, declared_early }`.
 */
export async function completeTileEarly(claimId) {
  const { data, error } = await supabase.rpc('complete_tile_early', { p_claim_id: claimId });
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Spend one pet jar preview on a tile this team could still claim. Returns
 * `{ name, icon, pet_jar_count }` — never claim_result or anything ship-
 * related, and refuses server-side if the counter is at 0, the tile is
 * already claimed by this team, or already previewed (0039).
 */
export async function spendPetJar(tileId) {
  const { data, error } = await supabase.rpc('spend_pet_jar', { p_tile_id: tileId });
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

/** Admins may rename either team; captains may rename only their own team. */
export const renameTeam = (teamId, name) =>
  rpc('rename_team', { p_team_id: teamId, p_name: name });

export const adminCreateGame = (name, teamA, teamB, gridSize = 10, maxActive = 2) =>
  rpc('admin_create_game', {
    p_name: name, p_team_a: teamA, p_team_b: teamB,
    p_grid_size: gridSize, p_max_active: maxActive,
  });

/** tiles: [{ row, col, name, icon }] — must be exactly gridSize^2 of them. */
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

/**
 * Roll a game back to preparation. Keeps the tiles and the roster; clears
 * locked-in tiles, the feed, manual score adjustments, the winner, and (by
 * default) the fleets.
 */
export const adminResetGame = (gameId, clearFleets = true) =>
  rpc('admin_reset_game', { p_game_id: gameId, p_clear_fleets: clearFleets });

/**
 * Give a team its slot back on a tile it cannot finish (0029).
 *
 * Admin only, and deliberately so: a captain able to drop their own square could
 * lock in, read the tile name, release, and repeat, which hands over the task
 * list a square at a time. The claim is deleted rather than flagged, so the
 * square becomes lockable again — and its submitted screenshots go with it.
 * Returns `{ released, position, evidence_deleted }`; show that count before
 * confirming. A fired tile is refused.
 */
export const adminReleaseClaim = (claimId) =>
  rpc('admin_release_claim', { p_claim_id: claimId });

/**
 * Discord webhook config (0040). `teamId` null means the shared/general
 * channel; a team id scopes it to that team's own private channel (evidence
 * and pet-jar submissions route there, never to general — see 0036/0039).
 */
export const adminListWebhooks = (gameId) =>
  rpc('admin_list_webhooks', { p_game_id: gameId });

export const adminSetWebhook = (gameId, teamId, url, enabled = true) =>
  rpc('admin_set_webhook', {
    p_game_id: gameId, p_team_id: teamId, p_url: url, p_enabled: enabled,
  });

export const adminDeleteWebhook = (id) =>
  rpc('admin_delete_webhook', { p_id: id });
