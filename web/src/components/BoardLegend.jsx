/**
 * What the colours mean, under the board they mean it on.
 *
 * The two boards get different words for the same two classes, because a hit
 * is one event with two readings: on enemy waters it is a hull you struck, on
 * your own fleet it is damage you took. The colours say the same thing —
 * green for a hit you dealt, red only for one you took. Good news and harm,
 * from the reader's side, never the other way round.
 *
 * The fleet view has a third shade the enemy board never needs: once every
 * cell of a ship is hit, those squares go from "damaged" red to a deader,
 * darker red — the ship, not just the square, is gone.
 *
 * Enemy waters names no ship colour, deliberately: an undamaged enemy hull is
 * secret, so there is nothing there for a legend to describe.
 */
export default function BoardLegend({ view }) {
  if (view === 'fleet') {
    return (
      <p className="legend">
        <span className="key ship" /> your ship
        <span className="key hit" /> hull hit
        <span className="key hit sunk" /> ship sunk
        <span className="key miss" /> they missed
      </p>
    );
  }

  return (
    <p className="legend">
      <span className="key active" /> locked in, not yet fired
      <span className="key hit dealt" /> your hit
      <span className="key miss" /> your miss
    </p>
  );
}
