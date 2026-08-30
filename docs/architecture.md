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
| `games` | A single match: status, grid size, fleet composition, active-tile limit, winner |
| `teams` | Exactly two per game (enforced by trigger), plus the Discord role to ping |
| `team_members` | Who plays for whom, and who is captain (captains place the fleet) |
| `tiles` | The 100 tasks — coordinate, name, and an optional icon slug |
| `ships` / `ship_cells` | Each team's placement. **Secret from the opponent** |
| `tile_claims` | Claim → fire. A completed claim *is* a shot |
| `game_events` | Append-only feed: powers Realtime and the Discord relay |
| `score_events` | Manual adjustments + audit trail (the sheet's "+1" button) |

### The tile grid is shared
Both teams see the same task at the same coordinate — that is how the original
worked, and both `Enemy` tabs confirmed identical tile names at identical positions.
So `tiles` hangs off `games`, not off a team. Each team claims and fires them
independently against the opponent's board.

### A shot is a completed claim
There is deliberately no separate `shots` table. In this game you fire *by*
completing a tile's task, so `tile_claims` going `active → fired` with a
`result` carries everything a shot needs. One table, one source of truth.

### Ship-sunk is derived, never stored
The view `ship_status` counts, per ship, how many of its cells the *opponent* has
hit and compares that to the ship's size. The Sheets version diffed a snapshot
kept in `PropertiesService`, which drifted on reset and could miss concurrent
sinks — this cannot.

### Score is derived too
`team_scores` totals each team from what the board already records — tiles fired,
hits, enemy ships finished off — times per-game weights on `games`
(`points_per_tile`, `points_per_hit`, `points_per_sink`), plus the sum of manual
adjustments. Nothing stores a running total, so nothing can drift, and changing a
weight simply re-totals both teams.

`score_events` keeps its original job: the sheet's "+1" button, as an audit trail.
Its `reason` is free text an admin types, which makes it the one place in the
schema that *could* name a tile — so unlike every other public channel here it is
**not** world-readable. Rows are visible to the team they concern and to admins;
everyone sees the totals through `team_scores`, which exposes counts only. The
`score_adjusted` event carries the delta and never the reason, for the same
reason the shot events carry no tile name.

## Game rules, and where each is enforced

| Rule | Enforced by |
|---|---|
| No turn order — fire whenever a slot is free | Nothing to enforce; no rule exists |
| At most **2 active tiles** per team | `before insert` trigger on `tile_claims`, reading `games.max_active_tiles` |
| A team claims a given tile at most once | `unique (team_id, tile_id)` |
| A team's ships may not overlap | `unique (team_id, row, col)` on `ship_cells` |
| Fleet must be exactly `2,3,3,4,5`, straight and contiguous | `place_fleet()` |
| **Fleets frozen once the game starts** | `before insert/update/delete` triggers on `ships` and `ship_cells` |
| Game ends when one fleet is fully sunk | `fire_tile()`, off the `ship_status` view |

### Why fleets are frozen by trigger, not just in the RPC
"Once the game starts, fleets cannot be moved by anyone" is a rule about *everyone* —
so it cannot live in the RPC alone, or a service-role call, an admin script or a
manual SQL edit would slip past it. The triggers sit on the tables themselves and
reject any write while the game is not in `placement`. (They allow cascade deletes,
so a game can still be torn down cleanly.)

## The two secrets

Everything else about this design follows from these:

1. **Enemy ship placement.** `ships` and `ship_cells` are readable only by members of
   the owning team. The opponent learns a cell's contents only as the result of
   their own shot.
2. **Unclaimed tile contents.** Teams pick tiles blind — a coordinate, not a task.
   So `tiles` has an RLS policy of `using (false)`: no client reads it directly. The
   app reads the `tiles_for_me` function, which returns `name` and `icon` only for
   tiles the viewer's own team has already claimed, and nulls for the rest.

   The icon is redacted for the same reason the name is: a Dragon warhammer on an
   unclaimed square gives it away. That redaction is also what keeps the image
   files out of reach — with no slug there is no filename, so an unclaimed tile
   generates no request and appears nowhere in the network log.

Because both are enforced in the database rather than the UI, there is no request a
determined player can craft to get around them — unlike the spreadsheet, where the
tile data sat in a reachable tab and placement was one `IMPORTRANGE` away.

### The event feed is the back door to secret #2
`game_events.payload` is world-readable, so it must never carry a tile's `name` or
`icon`. If it did, a team could read the opponent's claimed tiles out of the feed
and so learn what those same tiles are on its own board — the grid is shared.
Events therefore store `tile_id` and `position` only, and each client resolves the
name through `tiles_for_me`. The spreadsheet had the identical rule: its private
webhook named the tile, its general webhook deliberately did not.

## Game logic as RPCs

Clients hold **no** insert/update/delete rights. Narrow `security definer`
functions are the entire write surface for game actions:

| Function | Does |
|---|---|
| `place_fleet(team_id, ships)` | Captain-only, placement phase only. Validates each ship is straight, contiguous and in bounds, and that the fleet matches `2,3,3,4,5` |
| `start_game(game_id)` | Checks two teams with complete fleets, then flips to `active` — the point after which fleets are frozen |
| `claim_tile(tile_id)` | Reveals the tile to the claiming team and takes one of its two slots. No question — the pick *is* the move |
| `fire_tile(claim_id)` | Resolves HIT/MISS **synchronously**, frees the slot, and emits `shot_fired`, `ship_sunk`, `game_won` events as warranted |
| `rename_team(team_id, name)` | Lets an admin rename either team or a captain rename only their own; validates the name and emits `team_renamed` for live refresh |

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

## Dropped from the spreadsheet version

- **The trivia gate.** Tiles no longer have a question or an answer to fuzzy-match,
  so the Levenshtein matcher and the `answer_variants` column are gone. Claiming a
  tile is now the whole unlock step.
- **The BFS flood-fill.** It existed to *discover* ships from a dumb TRUE/FALSE grid.
  The web UI already knows which cells belong to which ship, so `place_fleet` only
  has to validate.
- **The HIT/MISS polling loop**, and the **`PropertiesService` snapshot diff**.

## Open questions

- Do claimed-but-unfired tiles survive a game reset?
- ~~Should there be an admin override to end or roll back a game mid-flight?~~
  Yes — `admin_reset_game` (0013). Rolls back to `placement`, keeping the tiles
  and roster and optionally the fleets. Status is reset *before* the ships are
  deleted, because the freeze triggers reject ship writes outside `placement`.
- Per-player scoring: derive purely from `tile_claims`, or keep manual adjustments?
