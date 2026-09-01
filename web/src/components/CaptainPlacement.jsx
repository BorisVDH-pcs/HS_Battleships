import { useState } from 'react';
import FleetPlacer from './FleetPlacer.jsx';

/**
 * The preparation phase, as a player sees it. (The database status is still
 * spelled `placement`; see lib/status.js.)
 *
 * `place_fleet()` has allowed a captain since 0002 — until now only the admin
 * console ever called it, so the organiser had to position both fleets himself.
 * This is the captain's own way in. Nothing about the permission changed: the
 * RPC still refuses anyone who is not a captain of that team, and the freeze
 * triggers still refuse everyone once the game leaves `placement`.
 *
 * A saved fleet is not shown back inside the placer. `place_fleet` is
 * all-or-nothing — it wipes the team's ships and re-inserts — so re-opening the
 * yard with the old ships still drawn would suggest you were editing them when
 * you are really starting again. It asks for confirmation instead.
 */
export default function CaptainPlacement({
  isCaptain, teamId, teamName, fleet, shipsPlaced, onPlaced,
}) {
  const [repositioning, setRepositioning] = useState(false);

  const total = fleet?.length ?? 0;
  const done = total > 0 && shipsPlaced === total;

  if (!isCaptain) {
    return (
      <section className="card">
        <h2>Fleet preparation</h2>
        <p className="muted">
          {done
            ? `Your captain has positioned the ${teamName} fleet. The game starts once both teams are ready.`
            : `Your captain is positioning the ${teamName} fleet. Nothing for you to do yet.`}
        </p>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Place your fleet</h2>

      {done && !repositioning ? (
        <>
          <p className="muted">
            All {total} hulls are on the board. Your ships are shown under
            <strong> Your fleet</strong> below. They lock the moment the admin
            starts the game.
          </p>
          <button className="ghost" onClick={() => setRepositioning(true)}>
            Reposition the fleet
          </button>
        </>
      ) : (
        <>
          {done && (
            <p className="muted">
              Starting again from an empty board — saving replaces your current
              fleet entirely. Leave this page without saving to keep it as it is.
            </p>
          )}
          <FleetPlacer
            teamId={teamId}
            teamName={teamName}
            fleet={fleet}
            onPlaced={() => { setRepositioning(false); onPlaced?.(); }}
          />
        </>
      )}
    </section>
  );
}
