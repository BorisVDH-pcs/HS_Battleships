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
