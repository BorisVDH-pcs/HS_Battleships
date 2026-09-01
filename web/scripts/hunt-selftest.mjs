/**
 * Offline check on the search in simulate-hunt.mjs. No database, no network.
 *
 * It plays the hunt against thousands of random fleets and reports how many
 * shots it needs to clear the board. This is the thing worth testing: a search
 * that quietly falls back to firing at random still finishes a game, and the
 * only way to notice is to count.
 *
 *   node scripts/hunt-selftest.mjs [games]
 *
 * Reference points for a 10x10 board with ships 5,4,3,3,2 (17 cells):
 *   random firing        ~95 shots, ~18% on target
 *   parity + target      ~55-65 shots, ~28-32% on target
 *   perfect play         17 shots
 */

import { randomFleet, newBrain, nextShot, learn, sunk, posOf, GRID } from './simulate-hunt.mjs';

const games = Number(process.argv[2] ?? 2000);

let totalShots = 0, totalHits = 0, worst = 0, best = Infinity, failures = 0;
const histogram = new Map();

for (let g = 0; g < games; g++) {
  const fleet = randomFleet();

  // Which ship each occupied square belongs to, so a sinking can be detected
  // the way the server detects it.
  const owner = new Map();
  fleet.forEach((ship, i) => ship.cells.forEach((c) => owner.set(posOf(c.row, c.col), i)));
  const left = fleet.map((s) => s.size);

  const b = newBrain();
  let shots = 0, hits = 0;

  while (left.some((n) => n > 0)) {
    const p = nextShot(b);
    if (p === null) { failures++; break; }

    shots++;
    const shipIndex = owner.get(p);
    const result = shipIndex === undefined ? 'miss' : 'hit';
    if (result === 'hit') { hits++; left[shipIndex]--; }

    learn(b, p, result);
    if (result === 'hit' && left[shipIndex] === 0) sunk(b, p);

    if (shots > GRID * GRID) { failures++; break; }
  }

  totalShots += shots;
  totalHits += hits;
  worst = Math.max(worst, shots);
  best = Math.min(best, shots);
  const bucket = Math.floor(shots / 10) * 10;
  histogram.set(bucket, (histogram.get(bucket) ?? 0) + 1);
}

const avg = totalShots / games;
console.log(`${games} games`);
console.log(`  shots to clear the board:  avg ${avg.toFixed(1)}   best ${best}   worst ${worst}`);
console.log(`  hit rate:                  ${((totalHits / totalShots) * 100).toFixed(1)}%`);
console.log(`  games that never finished: ${failures}`);
console.log('\n  distribution');
for (const bucket of [...histogram.keys()].sort((a, b) => a - b)) {
  const n = histogram.get(bucket);
  console.log(`   ${String(bucket).padStart(3)}-${String(bucket + 9).padEnd(3)} ${'#'.repeat(Math.round((n / games) * 200))} ${n}`);
}

if (failures > 0) { console.error('\nFAIL: some games never finished'); process.exit(1); }
if (avg > 75) { console.error(`\nFAIL: ${avg.toFixed(1)} shots is no better than firing at random`); process.exit(1); }
console.log('\nok');
