import { supabase } from './supabase.js';

/**
 * Every game this player is rostered into, newest first.
 *
 * `games`, `teams` and `team_members` are all `for select using (true)` (0001),
 * so one nested read answers this without an RPC or a migration.
 *
 * The dedupe tie-break is NOT cosmetic. A player may sit in both teams of one
 * game -- 0024 keeps that legal on purpose, because one browser driving both
 * sides is a useful testing trick -- and three places already resolve that tie
 * by team name ascending: `my_team_in_game()` (0024), the RLS-side helpers it
 * feeds, and useGame.js, which takes the first match against `teams` ordered by
 * name. If the picker broke the tie any other way it would name one team in the
 * dropdown while the board played as the other.
 */
export async function listMyGames(uid) {
  if (!supabase || !uid) return [];

  const { data, error } = await supabase
    .from('team_members')
    .select('teams!inner(id, name, game_id, games!inner(id, name, status, created_at))')
    .eq('profile_id', uid);

  if (error) throw new Error(error.message);

  // A to-one embed comes back as an object on current PostgREST and as a
  // one-element array on older builds. Both shapes are accepted rather than
  // betting the picker on which one the project is running.
  const one = (v) => (Array.isArray(v) ? v[0] : v) ?? null;

  // Fold the rows down to one entry per game, keeping the name-first team.
  const byGame = new Map();
  for (const row of data ?? []) {
    const team = one(row.teams);
    const game = one(team?.games);
    if (!team || !game) continue;

    const existing = byGame.get(game.id);
    // localeCompare, matching the `order('name')` the rest of the app sorts by.
    if (existing && existing.teamName.localeCompare(team.name) <= 0) continue;

    byGame.set(game.id, {
      gameId: game.id,
      gameName: game.name,
      status: game.status,
      createdAt: game.created_at,
      teamId: team.id,
      teamName: team.name,
    });
  }

  return [...byGame.values()].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
}

// Per user: a shared browser on event night is realistic, and one player's
// choice must not decide the next player's board.
const pickKey = (uid) => `hs-battleships:game-pick:${uid}`;

export function readGamePick(uid) {
  if (!uid) return null;
  try {
    return localStorage.getItem(pickKey(uid));
  } catch {
    return null; // Private mode, or storage disabled. Not worth failing over.
  }
}

export function writeGamePick(uid, gameId) {
  if (!uid) return;
  try {
    if (gameId) localStorage.setItem(pickKey(uid), gameId);
    else localStorage.removeItem(pickKey(uid));
  } catch {
    /* nothing to do -- the pick just will not survive the reload */
  }
}
