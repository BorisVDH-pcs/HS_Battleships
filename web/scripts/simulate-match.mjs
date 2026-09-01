/**
 * Play a whole match, at a pace a spectator can follow.
 *
 * Why this exists as a script rather than a pile of SQL: every action has to be
 * its own COMMIT. Supabase Realtime pushes a change to the browsers when the
 * transaction commits, so a batch of SQL — however many pg_sleep() calls are
 * sprinkled through it — arrives in the watching windows as one lump at the end.
 * One RPC per HTTP request is one transaction each, which is what makes the
 * boards move a square at a time.
 *
 * It is not a back door. It signs in as two ordinary players and calls the same
 * RPCs the app calls: place_fleet, start_game, claim_tile, add_evidence. The
 * shot is never fired directly — add_evidence fires it when the evidence
 * requirement is met, exactly as it does for a real upload.
 *
 * Passwords come from the environment and are never written down here.
 *
 *   ALPHA_USER=... ALPHA_PASS=... BRAVO_USER=... BRAVO_PASS=... node scripts/simulate-match.mjs
 *
 * Options (environment):
 *   PACE   ms between visible actions      (default 1000)
 *   GAME   game name                       (default "Evidence Demo (scratch)")
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const here = dirname(fileURLToPath(import.meta.url));

// ---- config -------------------------------------------------------------

function fromEnvFile(name) {
  try {
    const txt = readFileSync(join(here, '..', '.env'), 'utf8');
    const line = txt.split(/\r?\n/).find((l) => l.startsWith(name + '='));
    return line ? line.slice(name.length + 1).trim() : undefined;
  } catch {
    return undefined;
  }
}

const SUPA_URL = process.env.VITE_SUPABASE_URL ?? fromEnvFile('VITE_SUPABASE_URL');
const SUPA_ANON = process.env.VITE_SUPABASE_ANON_KEY ?? fromEnvFile('VITE_SUPABASE_ANON_KEY');
const PACE = Number(process.env.PACE ?? 1000);
const GAME = process.env.GAME ?? 'Evidence Demo (scratch)';

// Set this to have the script place both fleets and then stop, waiting for an
// organiser to open play from the admin console, instead of starting the game
// itself. Closer to how a real event runs.
const WAIT_FOR_START = Boolean(process.env.WAIT_FOR_START);

const CREDS = {
  alpha: { user: process.env.ALPHA_USER, pass: process.env.ALPHA_PASS },
  bravo: { user: process.env.BRAVO_USER, pass: process.env.BRAVO_PASS },
};

for (const [side, c] of Object.entries(CREDS)) {
  if (!c.user || !c.pass) {
    console.error(`Missing ${side.toUpperCase()}_USER / ${side.toUpperCase()}_PASS.`);
    console.error('Set all four before running — this script never stores them.');
    process.exit(1);
  }
}
if (!SUPA_URL || !SUPA_ANON) {
  console.error('No Supabase URL/anon key found (looked in the environment and web/.env).');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same mapping the app uses: there is no email anywhere, just a synthetic one
// built from the RuneScape name. See web/src/lib/auth.js.
const emailFor = (u) => `${u.trim().toLowerCase().replace(/\s+/g, '_')}@players.hs-battleships.invalid`;

// ---- the match ----------------------------------------------------------
// Both fleets are scripted so the shot lists can be scripted too. A real team
// has to search for the enemy fleet; this one already knows where to aim, which
// is why the hit rate below is not a realistic one.

const cell = (row, col) => ({ row, col });

const FLEETS = {
  alpha: [
    { size: 5, cells: [cell(1, 1), cell(1, 2), cell(1, 3), cell(1, 4), cell(1, 5)] },
    { size: 4, cells: [cell(3, 1), cell(3, 2), cell(3, 3), cell(3, 4)] },
    { size: 3, cells: [cell(5, 1), cell(5, 2), cell(5, 3)] },
    { size: 3, cells: [cell(7, 1), cell(7, 2), cell(7, 3)] },
    { size: 2, cells: [cell(9, 1), cell(9, 2)] },
  ],
  bravo: [
    { size: 5, cells: [cell(2, 3), cell(2, 4), cell(2, 5), cell(2, 6), cell(2, 7)] },
    { size: 4, cells: [cell(4, 1), cell(5, 1), cell(6, 1), cell(7, 1)] },
    { size: 3, cells: [cell(9, 5), cell(9, 6), cell(9, 7)] },
    { size: 3, cells: [cell(5, 9), cell(6, 9), cell(7, 9)] },
    { size: 2, cells: [cell(10, 1), cell(10, 2)] },
  ],
};

// Alpha works through Bravo's 17 hull cells. Bravo lands 9 and misses 4.
const SHOTS = {
  alpha: [13, 14, 15, 16, 17, 31, 41, 51, 61, 85, 86, 87, 49, 59, 69, 91, 92],
  bravo: [1, 2, 100, 3, 4, 90, 5, 21, 20, 22, 23, 10, 24],
};

// Interleaved so the two boards fill in together.
const MOVES = [];
for (let i = 0; i < SHOTS.alpha.length; i++) {
  MOVES.push(['alpha', SHOTS.alpha[i]]);
  if (i < SHOTS.bravo.length) MOVES.push(['bravo', SHOTS.bravo[i]]);
}

// ---- run ----------------------------------------------------------------

const label = (p) => 'ABCDEFGHIJ'[(p - 1) % 10] + (Math.floor((p - 1) / 10) + 1);

async function signIn(side) {
  const client = createClient(SUPA_URL, SUPA_ANON);
  const { error } = await client.auth.signInWithPassword({
    email: emailFor(CREDS[side].user),
    password: CREDS[side].pass,
  });
  if (error) throw new Error(`${side} sign-in failed: ${error.message}`);
  return client;
}

async function rpc(client, name, args) {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}

async function main() {
  const cl = { alpha: await signIn('alpha'), bravo: await signIn('bravo') };
  console.log(`signed in as ${CREDS.alpha.user} and ${CREDS.bravo.user}`);

  const { data: games } = await cl.alpha.from('games').select('id,name,status').eq('name', GAME);
  const game = games?.[0];
  if (!game) throw new Error(`No game named "${GAME}" is visible to these players.`);
  if (game.status !== 'placement' && game.status !== 'active') {
    throw new Error(`"${GAME}" is ${game.status}. Reset it to preparation first, then re-run.`);
  }
  // An organiser may have set the fleets and opened play already. In that case
  // there is nothing to prepare — join the match in progress.
  const joining = game.status === 'active';

  const { data: teams } = await cl.alpha.from('teams').select('id,name').eq('game_id', game.id);
  const teamOf = {};
  for (const side of ['alpha', 'bravo']) {
    const { data: { user } } = await cl[side].auth.getUser();
    const { data: mem } = await cl[side].from('team_members').select('team_id').eq('profile_id', user.id);
    const mine = new Set((mem ?? []).map((m) => m.team_id));
    const team = teams.find((t) => mine.has(t.id));
    if (!team) throw new Error(`${CREDS[side].user} plays for no team in this game.`);
    teamOf[side] = team;
  }
  console.log(`alpha = ${teamOf.alpha.name} · bravo = ${teamOf.bravo.name}\n`);

  // --- preparation
  if (joining) {
    console.log('game is already running — joining in progress');
  } else {
  for (const side of ['alpha', 'bravo']) {
    await rpc(cl[side], 'place_fleet', { p_team_id: teamOf[side].id, p_ships: FLEETS[side] });
    console.log(`${teamOf[side].name}: fleet placed`);
    await sleep(PACE);
  }
  if (WAIT_FOR_START) {
    // The organiser starts the match, which is how a real event runs: the
    // captains report their fleets are placed and somebody with the admin
    // console opens play. The script just waits for the status to flip.
    console.log('\nwaiting for an organiser to start the game…');
    for (;;) {
      const { data: g } = await cl.alpha.from('games').select('status').eq('id', game.id).single();
      if (g.status === 'active') break;
      if (g.status !== 'placement') throw new Error(`game went to ${g.status} instead of active`);
      await sleep(1000);
    }
  } else {
    await rpc(cl.alpha, 'start_game', { p_game_id: game.id });
  }
  console.log('\n--- the game has begun ---\n');
  await sleep(PACE);
  }

  // Position -> tile id. Read per side, because this is the view that keeps a
  // tile's name hidden until that team locks the square in.
  const tileAt = {};
  for (const side of ['alpha', 'bravo']) {
    const rows = await rpc(cl[side], 'tiles_for_me', { p_game_id: game.id });
    tileAt[side] = Object.fromEntries(rows.map((r) => [r.position, r.id]));
  }

  // --- the match
  let n = 0;
  for (const [side, p] of MOVES) {
    const team = teamOf[side].name;

    const claim = await rpc(cl[side], 'claim_tile', { p_tile_id: tileAt[side][p] });
    console.log(`${String(++n).padStart(2)}. ${team} locks in ${label(p)}`);
    await sleep(PACE);

    // Screenshots go in quickly — they are not the spectacle, and a tile asking
    // for twenty of them would otherwise stall the match for twenty seconds.
    // The last one meets the requirement, and that is what fires the shot.
    let shot = null;
    for (let i = 1; i <= 30 && !shot; i++) {
      const r = await rpc(cl[side], 'add_evidence', {
        p_claim_id: claim.id,
        p_storage_path: `${game.id}/${teamOf[side].id}/${claim.id}/shot${i}.png`,
      });
      if (r.fired) shot = r.result;
      else await sleep(120);
    }
    console.log(`    ${team} fires ${label(p)} — ${String(shot).toUpperCase()}`);
    await sleep(PACE);

    const { data: g } = await cl[side]
      .from('games').select('status,winner_team_id').eq('id', game.id).single();
    if (g.status === 'finished') {
      const winner = teams.find((t) => t.id === g.winner_team_id);
      console.log(`\n--- ${winner?.name ?? 'someone'} wins ---`);
      return;
    }
  }

  console.log('\nMoves exhausted with no winner.');
}

main().catch((e) => {
  console.error('\n' + e.message);
  process.exit(1);
});
