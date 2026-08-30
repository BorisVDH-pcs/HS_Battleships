# How the spreadsheet version worked

Reference notes on the Google Sheets + Apps Script implementation (Battleships V3),
captured before the rebuild so no mechanic gets lost in translation.

## The three spreadsheets

| Sheet | Role |
|---|---|
| **Middleman Spreadsheet** | Referee. Holds the master `Tile Data` (100 tiles), and per-team tabs (`Blad1`, `Blad2`) that cross-reference "hits done" against the opposing team's ship placement to resolve HIT/MISS. Also a `GOT EM` tab as an anti-tamper easter egg. |
| **Game Board — Kriegsmarine** | Team A's board: own ship placement, enemy shots received, the enemy tile grid, and a per-player `Counter` tab. |
| **Game Board — Flikkerlikkers** | Team B's board, identical structure. |

Team placement grids were pulled into the Middleman sheet via `IMPORTRANGE`.

## Game flow

### 1. Setup (once)
Each team marks ship cells TRUE/FALSE on their own 10x10 grid. Then
`setupShipsTeam1()` / `setupShipsTeamB()` run on the Middleman sheet:

- **BFS flood-fill** over TRUE cells finds connected groups (ships).
- Validates the fleet against the expected sizes `[2, 3, 3, 4, 5]`.
- Writes one `=AND(D15=TRUE; D16=TRUE; ...)` formula per ship into `C44:C48` —
  a live "every cell of this ship has been hit" boolean.

### 2. Unlocking a tile (the trivia gate)
`answerQuestionEnemy()` — player selects a numbered cell (1–100) on the `Enemy` tab:

- Tile numbers hide the real tasks — that is the fog of war.
- Looks the number up in the Middleman `Tile Data` sheet.
- Posts the question to Discord, then prompts for an answer.
- Answer checked with **Levenshtein distance**; multiple accepted answers split on `/`;
  tolerance 1 for answers ≤ 5 chars, else 2.
- On success: the number is replaced by the real tile name, and the tile is staged
  into `L6` — or `N6` if `L6` is taken. **Only two tiles may be armed at once.**

### 3. Firing (completing the task)
`CompleteTileL6()` / `CompleteTileN6()`:

- Confirmation prompt, then ticks a checkbox 3 rows below the tile.
- That checkbox drives the Middleman cross-reference formulas.
- Script **polls a cell 15 columns over for up to 120 s** waiting for HIT/MISS to appear,
  because formulas recalculate asynchronously.
- Result posted to two Discord webhooks (team-private + general) with a
  hit or miss GIF and a role ping.

### 4. Ship-sunk detection
Compares a **snapshot** of the ship-status column `M30:M35`, stored in
`PropertiesService`, against its current value. Any change ⇒ a ship just sank ⇒
taunt message pinging the opposing team's Discord role.

### 5. Admin
- `setCheckboxesFalse()` / `setCheckboxesFalse1()` — reset boards, re-seed tile numbers 1–100.
- `revealAllTiles()` — bulk-reveal all tile names at game end.
- `addOneToColumnD()` — manual +1 on the per-player `Counter` tab.

## Weaknesses the rebuild must fix

| Problem in Sheets | Why it hurts | Fix in the rebuild |
|---|---|---|
| 120 s polling loop for HIT/MISS | Slow, times out, blocks the UI | Resolve synchronously in the database; push via Realtime |
| Ship-sunk via snapshot diff in script properties | Drifts, breaks on reset, misses concurrent sinks | Derive from data — a ship is sunk when every cell has a hit |
| Tile answers live in a sheet teams can reach | Cheatable | Answers never leave the server; validated in a `security definer` function |
| Enemy ship placement is one `IMPORTRANGE` away | Cheatable | Row Level Security — placement is unreadable by the opponent |
| Discord webhooks hardcoded in script source | Secret leakage | Server-side env vars only |
| Two-slot arming enforced by checking `L6`/`N6` | Race conditions, fragile | Database constraint / trigger |
| Per-player score is a manual +1 button | Error-prone, no audit trail | Derived from actual events, with an adjustments table |
