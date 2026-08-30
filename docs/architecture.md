# Architecture

## Data model

```
profiles ──< team_members >── teams ──< ships ──< ship_cells
                                │
games ──────────────────────────┤
  │                             │
  ├──< tiles <── tile_claims >──┘
  ├──< game_events
  └──< score_events (via teams)
```

| Table | Holds |
|---|---|
| `profiles` | One row per logged-in user, mirrors `auth.users` |
| `games` | A single match: status, grid size, fleet composition, arming limit, winner |
| `teams` | Exactly two per game (enforced by trigger), plus the Discord role to ping |
| `team_members` | Who plays for whom, and who is captain (captains place the fleet) |
| `tiles` | The 100 tasks — coordinate, name, question, `answer_variants`, rules |
| `ships` / `ship_cells` | Each team's placement. **Secret from the opponent** |
| `tile_claims` | Unlock → fire. A completed claim *is* a shot |
| `game_events` | Append-only feed: powers Realtime and the Discord relay |
| `score_events` | Manual adjustments + audit trail (the sheet's "+1" button) |

### The tile grid is shared
Both teams see the same task at the same coordinate — that is how the original
worked, and both `Enemy` tabs confirmed identical tile names at identical positions.
So `tiles` hangs off `games`, not off a team. Each team unlocks and fires them
independently against the opponent's board.

### A shot is a completed claim
There is deliberately no separate `shots` table. In this game you fire *by*
completing a tile's task, so `tile_claims` with `status = 'fired'` and a
`result` carries everything a shot needs. One table, one source of truth.

### Ship-sunk is derived, never stored
The view `ship_status` counts, per ship, how many of its cells the *opponent* has
hit and compares that to the ship's size. The Sheets version diffed a snapshot
kept in `PropertiesService`, which drifted on reset and could miss concurrent
sinks — this cannot.

## The two secrets

Everything else about this design follows from these:

1. **Tile answers.** `tiles` has an RLS policy of `using (false)` — no client can read
   it at all. The app reads the `tiles_public` view instead, which simply omits
   `answer_variants`. Answer checking happens inside `unlock_tile()`.
2. **Enemy ship placement.** `ships` and `ship_cells` are readable only by members of
   the owning team. The opponent learns a cell's contents only as the result of
   their own shot.

Because both are enforced in the database rather than the UI, there is no request a
determined player can craft to get around them — unlike the spreadsheet, where the
answers sat in a reachable tab and placement was one `IMPORTRANGE` away.

## Game logic as RPCs

Clients hold **no** insert/update/delete rights. Three `security definer` functions
are the entire write surface:

| Function | Does |
|---|---|
| `place_fleet(team_id, ships)` | Captain-only. Validates each ship is straight, contiguous, in bounds, and that the fleet matches `2,3,3,4,5`. Overlap is caught by `unique(team_id,row,col)` |
| `unlock_tile(tile_id, answer)` | Levenshtein match (tolerance 1 for ≤5 chars, else 2 — ported from the Apps Script), then creates an armed claim |
| `fire_tile(claim_id)` | Resolves HIT/MISS **synchronously**, records the shot, and emits `shot_fired`, `ship_sunk`, `game_won` events as warranted |

The two-armed-tile rule (the sheet's `L6`/`N6` slots) is a `before insert` trigger
reading `games.max_armed_tiles`, so it cannot race.

## No more polling

The Apps Script ticked a checkbox and then polled a cell for up to 120 seconds
waiting for spreadsheet formulas to recalculate. Here `fire_tile()` returns the
result directly, and every other client learns about it through Supabase Realtime
subscribed to `game_events`.

## Discord relay

`game_events` rows are written first and relayed second, with `relayed_at` marking
what has been sent. A failed webhook therefore leaves a replayable backlog instead of
losing the message. Webhook URLs live in server-side env vars — never in source,
which is how the originals leaked.

## Open questions

- Turn order: the sheet had none — either team could fire whenever they had an
  armed tile. Keep it free-for-all, or add alternating turns?
- Do unlocked-but-unfired tiles stay visible to the team if the game resets?
- Should captains be able to re-place a fleet mid-game (admin override)?
