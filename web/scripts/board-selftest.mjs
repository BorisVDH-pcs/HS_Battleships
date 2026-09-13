import assert from 'node:assert/strict';
import {
  GRID, allCells, blockedCells, cellKey, coordLabel, fromPosition, inBounds,
  placementError, shipFootprint, sunkShipIds, toPosition,
} from '../src/lib/board.js';

// The 10×10 board has a single canonical mapping between UI coordinates and
// database positions. Check the full grid rather than a few representative
// cells: an off-by-one here makes a player shoot a different tile than shown.
const cells = allCells();
assert.equal(cells.length, GRID * GRID);
assert.equal(new Set(cells.map(({ row, col }) => cellKey(row, col))).size, 100);

for (const { row, col } of cells) {
  const position = toPosition(row, col);
  assert.equal(position >= 1 && position <= 100, true);
  assert.deepEqual(fromPosition(position), { row, col });
}

assert.equal(coordLabel(1, 1), 'A1');
assert.equal(coordLabel(10, 10), 'J10');
assert.deepEqual(fromPosition(1), { row: 1, col: 1 });
assert.deepEqual(fromPosition(100), { row: 10, col: 10 });

assert.deepEqual(shipFootprint(4, 3, 3, 'h'), [
  { row: 4, col: 3 }, { row: 4, col: 4 }, { row: 4, col: 5 },
]);
assert.deepEqual(shipFootprint(4, 3, 3, 'v'), [
  { row: 4, col: 3 }, { row: 5, col: 3 }, { row: 6, col: 3 },
]);
assert.equal(inBounds(shipFootprint(10, 9, 2, 'h')), true);
assert.equal(inBounds(shipFootprint(10, 9, 3, 'h')), false);

const forbidden = blockedCells([{ row: 5, col: 5 }]);
assert.equal(forbidden.size, 9);
assert.equal(forbidden.has(cellKey(4, 4)), true, 'diagonal contact is forbidden');
assert.equal(forbidden.has(cellKey(6, 6)), true, 'diagonal contact is forbidden');
assert.equal(placementError(shipFootprint(1, 1, 2, 'h'), [{ row: 3, col: 3 }]), null);
assert.equal(
  placementError(shipFootprint(1, 1, 2, 'h'), [{ row: 3, col: 3 }]),
  null,
  'a non-touching ship is allowed'
);
assert.equal(
  placementError(shipFootprint(1, 1, 2, 'h'), [{ row: 2, col: 2 }]),
  'Ships may not touch, not even at the corners'
);
assert.equal(placementError(shipFootprint(10, 10, 2, 'h'), []), 'Off the board');

const myShipCells = [
  { ship_id: 'alpha', row: 1, col: 1 },
  { ship_id: 'alpha', row: 1, col: 2 },
  { ship_id: 'beta', row: 2, col: 1 },
];
const tiles = [
  { id: 'first', position: 1 }, { id: 'second', position: 2 },
  { id: 'third', position: 11 },
];
assert.deepEqual(
  [...sunkShipIds(myShipCells, [
    { tile_id: 'first', result: 'hit' }, { tile_id: 'second', result: 'hit' },
    { tile_id: 'third', result: 'miss' },
  ], tiles)],
  ['alpha']
);
assert.equal(sunkShipIds([], [], tiles).size, 0, 'an empty hull is never sunk');

console.log('Board self-test passed.');
