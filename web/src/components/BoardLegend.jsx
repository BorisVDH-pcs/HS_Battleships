/**
 * What the colours mean, under the board they mean it on.
 *
 * The two boards get different words for the same two classes, because a hit
 * is one event with two readings: on enemy waters it is a hull you struck, on
 * your own fleet it is damage you took. The colours say the same thing —
 * green for a hit you dealt, red only for one you took. Good news and harm,
 * from the reader's side, never the other way round.
 *
 * Both boards share a third shade: once every cell of a ship is hit, those
 * squares go dark — the ship, not just the square, is gone. Enemy waters
 * names no colour for an undamaged hull, deliberately: it is still secret,
 * so there is nothing there for a legend to describe until it is hit.
 */
export default function BoardLegend({ view }) {
  if (view === 'fleet') {
    return (
      <p className="legend">
        <span className="legend-item"><span className="key ship" />your ship</span>
        <span className="legend-item"><span className="key hit" />hull hit</span>
        <span className="legend-item"><span className="key hit sunk" />ship sunk</span>
        <span className="legend-item"><span className="key miss" />they missed</span>
      </p>
    );
  }

  return (
    <p className="legend">
      <span className="legend-item"><span className="key active" />locked in, not yet fired</span>
      <span className="legend-item"><span className="key hit dealt" />your hit</span>
      <span className="legend-item"><span className="key hit dealt sunk" />ship sunk</span>
      <span className="legend-item"><span className="key miss" />your miss</span>
    </p>
  );
}
