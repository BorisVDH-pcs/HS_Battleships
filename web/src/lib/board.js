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
