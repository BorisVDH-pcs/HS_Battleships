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

/**
 * Counts per game, for the readiness badge on the Games list.
 *
 * Every game in one call rather than the per-game RPCs above in a loop. The
 * three numbers it returns are all behind RLS a client cannot read directly —
 * tiles refuses everyone, ship_cells answers only for your own team, and an
 * admin has none — and all three are counts, never content.
 */
export const adminGameReadiness = () => rpc('admin_game_readiness', {});

// ---- the tile library, and boards built one square at a time ----

/**
 * Every catalogued tile, most-used first. The rows come back in the same shape
 * `admin_list_tiles` returns a board in, so one renderer serves both.
 */
export const adminListLibrary = () => rpc('admin_list_library');

/**
 * Insert (`id` null) or update one catalogue entry. `tile` is the shape the
 * board builder's form emits — name, icon, amount, rule, perSet, description,
 * options[] — plus an optional `tags` array. Returns the entry's id.
 */
export const adminSaveLibraryTile = (id, tile) =>
  rpc('admin_save_library_tile', { p_id: id ?? null, p_tile: tile });

export const adminDeleteLibraryTile = (id) =>
  rpc('admin_delete_library_tile', { p_id: id });

/**
 * Fill one square. Same payload shape as `adminSaveLibraryTile`, plus
 * `libraryId` when it came from the catalogue. Overwrites whatever was there.
 */
export const adminSetTile = (gameId, row, col, tile) =>
  rpc('admin_set_tile', { p_game_id: gameId, p_row: row, p_col: col, p_tile: tile });

export const adminClearTile = (gameId, row, col) =>
  rpc('admin_clear_tile', { p_game_id: gameId, p_row: row, p_col: col });

/**
 * Play a list of drops into a tile and report whether it finishes, without
 * committing any of it.
 *
 * `picks` is one entry per screenshot, in submission order: `{ option_id }` on
 * a tile with drops, `{ amount }` on a value tile, `{}` on a plain count. The
 * answer comes from `claim_is_complete()` itself rather than from
 * `tileProgress.js` — the point is to ask the authority, not the mirror it is
 * kept in step with by hand.
 *
 * Nothing survives the call: the claim and its evidence live inside a
 * subtransaction the function rolls back, so no shot is fired, no event is
 * written, and the other team's board never flickers.
 */
export const adminTestTile = (tileId, picks) =>
  rpc('admin_test_tile', { p_tile_id: tileId, p_picks: picks });

/**
 * Saved boards.
 *
 * A whole board under a name, so a hundred hand-placed squares are not a thing
 * that exists in one copy with `admin_clear_board` next to them. The snapshot
 * is taken server-side and never travels through here — `admin_list_board_presets`
 * deliberately returns a name and a count, not the tiles, because a board IS the
 * tile list and that is secret #2.
 *
 * Applying REPLACES the board. Refused once a game is past placement, or if any
 * tile on it has been claimed.
 */
export const adminSaveBoardPreset = (gameId, name) =>
  rpc('admin_save_board_preset', { p_game_id: gameId, p_name: name });

export const adminListBoardPresets = () => rpc('admin_list_board_presets');

export const adminApplyBoardPreset = (gameId, presetId) =>
  rpc('admin_apply_board_preset', { p_game_id: gameId, p_preset_id: presetId });

export const adminDeleteBoardPreset = (presetId) =>
  rpc('admin_delete_board_preset', { p_preset_id: presetId });

/**
 * Empty every square on a board. Returns how many squares it removed. Refused
 * once the game is past preparation, like every other write to `tiles`.
 */
export const adminClearBoard = (gameId) =>
  rpc('admin_clear_board', { p_game_id: gameId });

/**
 * Deal random catalogue tiles into the squares that are still empty.
 *
 * Never touches a square that already has a tile, and never deals a task the
 * board already holds. Returns `{ filled, similar, empty, pool }` — `empty` is
 * how many squares it found, `filled` how many it could fill, and `similar` how
 * many of those had to be a near-duplicate of another task to get there.
 *
 * `tag`, when given, narrows the deal to catalogue entries carrying that tag —
 * the same filter the tile list above the button already offers.
 */
export const adminAutofillBoard = (gameId, tag = null) =>
  rpc('admin_autofill_board', { p_game_id: gameId, p_tag: tag || null });

/**
 * Move the tiles already on a board between the squares they occupy.
 *
 * The counterpart to dealing rather than a version of it: the catalogue is
 * never consulted, so no square can come out empty, a task placed more than
 * once stays placed more than once, and a one-off tile that exists nowhere but
 * on its square survives. Returns `{ tiles, moved }` — `moved` is how many
 * landed somewhere new, which on a real board is all but one or two of them.
 *
 * Refused once the game is past preparation: a square's coordinates are what a
 * team previewed, claimed and fired at.
 */
export const adminShuffleBoard = (gameId) =>
  rpc('admin_shuffle_board', { p_game_id: gameId });

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
