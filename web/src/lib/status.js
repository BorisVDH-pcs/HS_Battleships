/**
 * What a game status is called on screen.
 *
 * The `game_status` enum still spells the second phase `placement`. Renaming the
 * enum value itself would break every `= 'placement'` comparison in the PL/pgSQL
 * guards at once — `place_fleet`, `start_game`, `admin_set_tiles`,
 * `admin_open_placement`, `admin_reset_game` and the two freeze triggers all
 * compare against that literal — so the value stays and the vocabulary changes
 * here, at the only places a raw status reaches a person.
 *
 * Every screen that prints a status goes through this, so the two cannot drift.
 */
export function statusLabel(status) {
  return status === 'placement' ? 'preparation' : status;
}
