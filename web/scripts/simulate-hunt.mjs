/**
 * A match neither side has been told the answer to.
 *
 * simulate-match.mjs replays a script: the fleets are fixed and the shot lists
 * were written against them, so it lands 17 hits out of 17 and proves nothing
 * about how the game plays. This one gives each team the same information a
 * real one has — its own hits and misses, and the public "a ship went down"
 * events — and makes it go looking.
 *
 * The search is the standard human method:
 *
 *   HUNT    fire on a parity lattice, every other square, so that no ship of
 *           length 2 or more can hide between the shots. That is the diagonal
 *           pattern people fall into on squared paper. It halves the board.
 *   TARGET  on a hit, work the four neighbours. Once two hits line up, follow
 *           that line and stop trying the perpendicular ones — a ship is
 *           straight, so the other directions are wasted shots.
 *
 * Both fleets are placed at random each run, and neither AI can see the other's
 * board: it learns a square only from what add_evidence() hands back for its own
 * shot. So the result is not decided in advance. Whoever finds the fleet faster
 * wins, and the hit rate lands where a real game lands, somewhere near a third.
 *
 *   ALPHA_USER=... ALPHA_PASS=... BRAVO_USER=... BRAVO_PASS=... node scripts/simulate-hunt.mjs
 *
 * Options (environment):
 *   PACE   ms between visible actions   (default 1000)
 *   GAME   game name                    (default "Evidence Demo (scratch)")
 *   SEED   integer, repeats a run exactly
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

// Both captains place their fleets and then wait for an organiser to open play,
// which is how a real event runs. SELF_START=1 has the script start the game
// itself instead, for an unattended run.
const SELF_START = Boolean(process.env.SELF_START);

const CREDS = {
  alpha: { user: process.env.ALPHA_USER, pass: process.env.ALPHA_PASS },
  bravo: { user: process.env.BRAVO_USER, pass: process.env.BRAVO_PASS },
};

function checkConfig() {
  for (const [side, c] of Object.entries(CREDS)) {
    if (!c.user || !c.pass) {
      console.error(`Missing ${side.toUpperCase()}_USER / ${side.toUpperCase()}_PASS.`);
      process.exit(1);
    }
  }
  if (!SUPA_URL || !SUPA_ANON) {
    console.error('No Supabase URL/anon key found (looked in the environment and web/.env).');
    process.exit(1);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emailFor = (u) => `${u.trim().toLowerCase().replace(/\s+/g, '_')}@players.hs-battleships.invalid`;

// Seeded so a run can be repeated exactly when something odd shows up.
let seed = Number(process.env.SEED ?? Math.floor(Math.random() * 1e9));
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

// ---- board helpers ------------------------------------------------------

const GRID = 10;
const FLEET = [5, 4, 3, 3, 2];
const posOf = (row, col) => (row - 1) * GRID + col;
const rowOf = (p) => Math.floor((p - 1) / GRID) + 1;
const colOf = (p) => ((p - 1) % GRID) + 1;
const label = (p) => 'ABCDEFGHIJ'[colOf(p) - 1] + rowOf(p);
const inBounds = (r, c) => r >= 1 && r <= GRID && c >= 1 && c <= GRID;

/** A random legal fleet: straight ships, and none touching, not even at a corner. */
function randomFleet() {
  const taken = new Set();   // cells plus their surrounding ring
  const ships = [];

  for (const size of FLEET) {
    for (let attempt = 0; ; attempt++) {
      if (attempt > 2000) throw new Error('could not place a fleet');
      const horizontal = rand() < 0.5;
      const row = 1 + Math.floor(rand() * (horizontal ? GRID : GRID - size + 1));
      const col = 1 + Math.floor(rand() * (horizontal ? GRID - size + 1 : GRID));

      const cells = [];
      for (let i = 0; i < size; i++) {
        cells.push(horizontal ? { row, col: col + i } : { row: row + i, col });
      }
      if (cells.some((c) => taken.has(posOf(c.row, c.col)))) continue;

      for (const c of cells) {
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (inBounds(c.row + dr, c.col + dc)) taken.add(posOf(c.row + dr, c.col + dc));
          }
        }
      }
      ships.push({ size, cells });
      break;
    }
  }
  return ships;
}

// ---- the search ---------------------------------------------------------

/**
 * What one team knows about the board it is shooting at. Nothing is seeded into
 * this — every square in it was learned from that team's own shot.
 */
function newBrain() {
  return {
    tried: new Set(),      // every square this team has fired on
    hits: new Set(),       // the ones that landed
    water: new Set(),      // squares deduced empty — never worth a shot
    queue: [],             // squares to try next, nearest work first
    mode: 'hunt',
  };
}

/** Nothing to learn here: already fired on, or known to be empty. */
const blocked = (b, p) => b.tried.has(p) || b.water.has(p);

function diagonals(p) {
  const r = rowOf(p), c = colOf(p);
  return [[r - 1, c - 1], [r - 1, c + 1], [r + 1, c - 1], [r + 1, c + 1]]
    .filter(([rr, cc]) => inBounds(rr, cc))
    .map(([rr, cc]) => posOf(rr, cc));
}

/** The eight squares around one cell. */
function ring(p) {
  const r = rowOf(p), c = colOf(p);
  const out = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if ((dr || dc) && inBounds(r + dr, c + dc)) out.push(posOf(r + dr, c + dc));
    }
  }
  return out;
}

/** The run of hits joined to p — the ship that was just being worked. */
function cluster(b, p) {
  const seen = new Set([p]);
  const stack = [p];
  while (stack.length) {
    for (const n of neighbours(stack.pop())) {
      if (b.hits.has(n) && !seen.has(n)) { seen.add(n); stack.push(n); }
    }
  }
  return [...seen];
}

function neighbours(p) {
  const r = rowOf(p), c = colOf(p);
  return [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]
    .filter(([rr, cc]) => inBounds(rr, cc))
    .map(([rr, cc]) => posOf(rr, cc));
}

function nextShot(b) {
  // Target mode: finish what has been started.
  while (b.queue.length) {
    const p = b.queue.shift();
    if (!blocked(b, p)) return p;
  }
  b.mode = 'hunt';

  // Hunt mode: the parity lattice, skipping everything deduced to be empty.
  // Nothing of length 2 fits between these.
  const lattice = [];
  const rest = [];
  for (let p = 1; p <= GRID * GRID; p++) {
    if (blocked(b, p)) continue;
    ((rowOf(p) + colOf(p)) % 2 === 0 ? lattice : rest).push(p);
  }
  const from = lattice.length ? lattice : rest;
  if (!from.length) return null;
  return pick(from);
}

function learn(b, p, result) {
  b.tried.add(p);
  if (result !== 'hit') return;

  b.hits.add(p);
  b.mode = 'target';

  // Ships may not touch, not even at a corner, and a ship is straight — so a
  // diagonal neighbour of a hit can be neither this ship nor another one. It is
  // water, known for free, and a shot there would always be wasted.
  for (const d of diagonals(p)) if (!b.hits.has(d)) b.water.add(d);

  // Two hits in a row means the ship's axis is known. Drop everything
  // perpendicular — a ship is straight, so those squares cannot be it.
  const r = rowOf(p), c = colOf(p);
  const horizontal = b.hits.has(posOf(r, c - 1)) || b.hits.has(posOf(r, c + 1));
  const vertical = b.hits.has(posOf(r - 1, c)) || b.hits.has(posOf(r + 1, c));

  let next = neighbours(p).filter((n) => !blocked(b, n));
  if (horizontal && !vertical) next = next.filter((n) => rowOf(n) === r);
  else if (vertical && !horizontal) next = next.filter((n) => colOf(n) === c);

  // Extend along a known line first: the far end of the run is likelier than
  // a fresh neighbour of the square just hit.
  b.queue = [...next, ...b.queue];
}

/**
 * A ship went down. Whatever was left in the queue belonged to it, and — since
 * nothing may touch it — every square around the wreck is water. On a 5-tile
 * ship that is up to sixteen squares crossed off without firing at them, which
 * is the single biggest saving in the whole search.
 */
function sunk(b, lastHit) {
  const wreck = lastHit === undefined ? [] : cluster(b, lastHit);
  for (const cellPos of wreck) {
    for (const n of ring(cellPos)) if (!b.hits.has(n)) b.water.add(n);
  }
  b.queue = [];
  b.mode = 'hunt';
}

// ---- run ----------------------------------------------------------------

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
  checkConfig();
  console.log(`seed ${seed} — pass SEED=${seed} to replay this exact match\n`);

  const cl = { alpha: await signIn('alpha'), bravo: await signIn('bravo') };

  const { data: games } = await cl.alpha.from('games').select('id,name,status').eq('name', GAME);
  const game = games?.[0];
  if (!game) throw new Error(`No game named "${GAME}" is visible to these players.`);
  if (game.status !== 'placement' && game.status !== 'active') {
    throw new Error(`"${GAME}" is ${game.status}. Reset it to preparation first, then re-run.`);
  }
  // An organiser may have set play going already — or this script placed the
  // fleets, was interrupted, and is being run again. Either way there is nothing
  // to prepare: join, and rebuild what each side knows from its own past shots.
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
  console.log(`${teamOf.alpha.name} (${CREDS.alpha.user}) vs ${teamOf.bravo.name} (${CREDS.bravo.user})\n`);

  // --- preparation: random fleets, unknown to the other side
  if (joining) {
    console.log('game is already running — joining in progress\n');
  } else {
  for (const side of ['alpha', 'bravo']) {
    await rpc(cl[side], 'place_fleet', { p_team_id: teamOf[side].id, p_ships: randomFleet() });
    console.log(`${teamOf[side].name}: fleet placed`);
    await sleep(PACE);
  }
  if (SELF_START) {
    await rpc(cl.alpha, 'start_game', { p_game_id: game.id });
  } else {
    console.log('\nboth fleets are set — waiting for an organiser to start the game…');
    for (;;) {
      const { data: g } = await cl.alpha.from('games').select('status').eq('id', game.id).single();
      if (g.status === 'active') break;
      if (g.status !== 'placement') throw new Error(`game went to ${g.status} instead of active`);
      await sleep(1000);
    }
  }
  console.log('\n--- the game has begun ---\n');
  await sleep(PACE);
  }

  const brain = { alpha: newBrain(), bravo: newBrain() };
  const tileAt = {};
  for (const side of ['alpha', 'bravo']) {
    const rows = await rpc(cl[side], 'tiles_for_me', { p_game_id: game.id });
    tileAt[side] = Object.fromEntries(rows.map((r) => [r.position, r.id]));

    // Rebuild the search from this team's own record. Squares already locked in
    // cannot be locked in again, so a fresh brain would try one and fall over.
    for (const r of rows) {
      if (r.claim_status === 'fired') learn(brain[side], r.position, r.claim_result);
      else if (r.claim_id) brain[side].tried.add(r.position);
    }
    const known = brain[side].tried.size;
    if (known) console.log(`${teamOf[side].name}: picking up ${known} square(s) already played`);
  }
  const stats = { alpha: { shots: 0, hits: 0 }, bravo: { shots: 0, hits: 0 } };
  // Seeded from the feed, not from zero — otherwise a rejoined game reports the
  // first shot as a sinking because the count "went up" from nothing.
  const sinkCount = {};
  for (const side of ['alpha', 'bravo']) {
    const { count } = await cl[side]
      .from('game_events')
      .select('id', { count: 'exact', head: true })
      .eq('game_id', game.id).eq('team_id', teamOf[side].id).eq('type', 'ship_sunk');
    sinkCount[side] = count ?? 0;
  }

  // How many tiles a team may hold at once — the game's own setting, not an
  // assumption. Two is the default, and a team that only ever holds one is not
  // playing the game the rules describe.
  const { data: gameRow } = await cl.alpha
    .from('games').select('max_active_tiles').eq('id', game.id).single();
  const MAX_ACTIVE = gameRow?.max_active_tiles ?? 2;
  console.log(`each team may hold ${MAX_ACTIVE} tiles at once\n`);

  // A tile being worked: locked in, screenshots going in one at a time.
  const work = { alpha: [], bravo: [] };
  let move = 0;

  /** Everything that follows a shot going off, whoever fired it. */
  async function resolve(side, job, result) {
    const b = brain[side];
    learn(b, job.position, result);
    stats[side].shots++;
    if (result === 'hit') stats[side].hits++;
    work[side] = work[side].filter((j) => j !== job);

    // "A ship went down" is public, and it is the one extra thing a real player
    // reads off the feed. It names a ship, never which one or where.
    const { count } = await cl[side]
      .from('game_events')
      .select('id', { count: 'exact', head: true })
      .eq('game_id', game.id).eq('team_id', teamOf[side].id).eq('type', 'ship_sunk');
    let note = '';
    if ((count ?? 0) > sinkCount[side]) {
      sinkCount[side] = count;
      sunk(b, job.position);
      note = '  — and she goes down!';
    }
    return note;
  }

  /** One action for one team: lock a square in, or push a tile along. */
  async function tick(side) {
    const b = brain[side];
    const team = teamOf[side].name;
    const jobs = work[side];

    // Take a free slot when there is one, so both are in use.
    if (jobs.length < MAX_ACTIVE) {
      const p = nextShot(b);
      if (p !== null) {
        b.tried.add(p);   // claimed now, so the search will not pick it twice
        const claim = await rpc(cl[side], 'claim_tile', { p_tile_id: tileAt[side][p] });

        // The tile's requirements are secret until the team locks it in — this
        // read is the reveal, and it is per team.
        const rows = await rpc(cl[side], 'tiles_for_me', { p_game_id: game.id });
        const t = rows.find((r) => r.position === p);
        jobs.push({
          claimId: claim.id, position: p, count: 0,
          required: t?.required_evidence ?? 1,
          early: Boolean(t?.early_complete),
        });
        console.log(`${String(++move).padStart(3)}. ${team} locks in ${label(p)}`
          + `   [${b.mode}, ${jobs.length}/${MAX_ACTIVE} slots, needs ${t?.required_evidence ?? 1}`
          + `${t?.early_complete ? ', short route allowed' : ''}]`);
        return true;
      }
      if (!jobs.length) return false;   // nothing left to shoot at, nothing held
    }

    // Otherwise advance one of the tiles in hand. Picking at random is what
    // makes the two slots visibly interleave rather than run in sequence.
    const job = pick(jobs);

    // Some tiles have a second, shorter route. A team that has one screenshot in
    // and a long way still to go will often take it — which is the point of the
    // flag, and worth seeing in a run.
    if (job.early && job.count >= 1 && job.count < job.required && rand() < 0.5) {
      const r = await rpc(cl[side], 'complete_tile_early', { p_claim_id: job.claimId });
      const note = await resolve(side, job, r.result);
      console.log(`     ${team} calls ${label(job.position)} done by the short route`
        + ` (${job.count}/${job.required}) — ${String(r.result).toUpperCase()}${note}`);
      return true;
    }

    const r = await rpc(cl[side], 'add_evidence', {
      p_claim_id: job.claimId,
      p_storage_path: `${game.id}/${teamOf[side].id}/${job.claimId}/shot${job.count + 1}.png`,
    });
    job.count = r.evidence_count;

    if (!r.fired) {
      console.log(`     ${team} submits ${job.count}/${job.required} for ${label(job.position)}`);
      return true;
    }
    const note = await resolve(side, job, r.result);
    console.log(`     ${team} fires ${label(job.position)} — ${String(r.result).toUpperCase()}${note}`);
    return true;
  }

  // --- the match
  let turn = 'alpha';
  for (let action = 1; action <= 2000; action++) {
    const side = turn;
    turn = side === 'alpha' ? 'bravo' : 'alpha';

    const did = await tick(side);
    if (!did && !work[side].length && nextShot(brain[side]) === null) {
      console.log(`${teamOf[side].name} has nothing left to play`);
    }
    await sleep(PACE);

    const { data: g } = await cl[side]
      .from('games').select('status,winner_team_id').eq('id', game.id).single();
    if (g.status === 'finished') {
      const winner = teams.find((t) => t.id === g.winner_team_id);
      console.log(`\n--- ${winner?.name ?? 'someone'} wins ---`);
      for (const s of ['alpha', 'bravo']) {
        const { shots, hits } = stats[s];
        const pct = shots ? Math.round((hits / shots) * 100) : 0;
        console.log(`${teamOf[s].name.padEnd(12)} ${hits}/${shots} shots on target (${pct}%)`);
      }
      return;
    }
  }

  console.log('\nAction limit reached with no winner.');
}

// The search itself is exported so it can be tested offline, against thousands
// of boards, without touching the database. See scripts/hunt-selftest.mjs.
export { randomFleet, newBrain, nextShot, learn, sunk, posOf, rowOf, colOf, label, FLEET, GRID };

const runDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (runDirectly) {
  main().catch((e) => {
    console.error('\n' + e.message);
    process.exit(1);
  });
}
