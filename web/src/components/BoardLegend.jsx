/**
 * What the colours mean, under the board they mean it on.
 *
 * The two boards get different words for the same two classes, because a hit
 * is one event with two readings: on enemy waters it is a hull you struck, on
 * your own fleet it is damage you took. The colours say the same thing —
 * ember for a hit you dealt, red only for one you took.
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
        <span className="key miss" /> they missed
      </p>
    );
  }

  return (
    <p className="legend">
      <span className="key active" /> claimed, not yet fired
      <span className="key hit dealt" /> your hit
      <span className="key miss" /> your miss
    </p>
  );
}
