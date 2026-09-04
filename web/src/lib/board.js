// Board helpers. Coordinates are 1-based; column 1 is 'A', matching the
// spreadsheet's A1..J10 labelling and the `position` column in the database.

export const GRID = 10;

export const colLetter = (col) => String.fromCharCode(64 + col);

/** (row, col) -> 'B7' */
export const coordLabel = (row, col) => `${colLetter(col)}${row}`;

/** (row, col) -> 1..100, left-to-right then top-to-bottom (matches tiles.position). */
export const toPosition = (row, col) => (row - 1) * GRID + col;

/** 1..100 -> { row, col } */
export function fromPosition(position) {
  return {
    row: Math.floor((position - 1) / GRID) + 1,
    col: ((position - 1) % GRID) + 1,
  };
}

/** Every (row, col) on the board, in reading order. */
export function allCells() {
  const cells = [];
  for (let row = 1; row <= GRID; row++) {
    for (let col = 1; col <= GRID; col++) cells.push({ row, col });
  }
  return cells;
}

/** Key for lookup maps. */
export const cellKey = (row, col) => `${row}:${col}`;

/**
 * Which of my own ships are down, derived on the client.
 *
 * `ship_status.sunk` cannot answer this for a player, and quietly says "no" to
 * every ship rather than failing. The view is `security_invoker`, and it counts
 * hits by joining through `tiles` — a table players are forbidden to read at
 * all (the `tiles_no_direct_read` policy is a flat `false`, which is what stops
 * tile contents leaking). With that join returning nothing, `hits` comes out 0
 * and `sunk` false for every hull, so a player's own board showed a fleet that
 * could be hit but never sunk, under a legend that promised otherwise.
 *
 * Everything needed is already on the client and already permitted: my own ship
 * cells, the enemy's fired claims, and the tile positions `tiles_for_me`
 * returns. So this derives it the same way the organiser's board does, and
 * reads nothing new — no tile contents, and nothing about where the enemy's
 * own ships are.
 *
 * The server is unaffected: `fire_tile` and scoring read the same view from
 * inside `security definer` functions, where the join works.
 */
export function sunkShipIds(myShipCells, enemyShots, tiles) {
  const tilePos = new Map((tiles ?? []).map((t) => [t.id, t.position]));

  const hitCells = new Set();
  for (const shot of enemyShots ?? []) {
    if (shot.result !== 'hit') continue;
    const position = tilePos.get(shot.tile_id);
    if (!position) continue;
    const { row, col } = fromPosition(position);
    hitCells.add(cellKey(row, col));
  }

  const cellsByShip = new Map();
  for (const c of myShipCells ?? []) {
    if (!cellsByShip.has(c.ship_id)) cellsByShip.set(c.ship_id, []);
    cellsByShip.get(c.ship_id).push(cellKey(c.row, c.col));
  }

  const sunk = new Set();
  for (const [shipId, cells] of cellsByShip) {
    // A hull with no cells is not a sunk hull; it is a hull we know nothing
    // about, and `every` on an empty list would call it sunk.
    if (cells.length > 0 && cells.every((k) => hitCells.has(k))) sunk.add(shipId);
  }
  return sunk;
}

// ---- fleet placement -----------------------------------------------------

/** The cells a ship of `size` would cover from (row, col). `dir` is 'h' or 'v'. */
export function shipFootprint(row, col, size, dir) {
  const cells = [];
  for (let i = 0; i < size; i++) {
    cells.push(dir === 'h' ? { row, col: col + i } : { row: row + i, col });
  }
  return cells;
}

export const inBounds = (cells) =>
  cells.every((c) => c.row >= 1 && c.col >= 1 && c.row <= GRID && c.col <= GRID);

/**
 * Ships may not touch, not even at the corners, so every placed cell also
 * blocks its eight neighbours. Returns the full set of forbidden keys.
 *
 * This mirrors the check in place_fleet(); the server is still the authority,
 * this exists so the UI can refuse a bad drop instead of round-tripping an error.
 */
export function blockedCells(placedCells) {
  const blocked = new Set();
  for (const c of placedCells) {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) blocked.add(cellKey(c.row + dr, c.col + dc));
    }
  }
  return blocked;
}

/** null when the placement is legal, otherwise a reason to show the user. */
export function placementError(cells, placedCells) {
  if (!inBounds(cells)) return 'Off the board';
  const blocked = blockedCells(placedCells);
  if (cells.some((c) => blocked.has(cellKey(c.row, c.col)))) {
    return 'Ships may not touch, not even at the corners';
  }
  return null;
}
