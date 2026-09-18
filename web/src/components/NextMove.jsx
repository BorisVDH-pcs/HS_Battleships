/**
 * A short, state-aware prompt for the one action a player should take next.
 * It deliberately stays separate from the board controls: the prompt answers
 * "what now?" while the board and active-tile cards remain where the action
 * happens.
 */
export default function NextMove({ activeCount, maxActive, canClaim, isFinished }) {
  if (isFinished) {
    return (
      <section className="next-move next-move-finished" aria-label="Match status">
        <div>
          <span className="eyebrow">Match complete</span>
          <h2>The battle is over</h2>
        </div>
        <p>Review the final boards and activity feed below.</p>
      </section>
    );
  }

  const full = activeCount >= maxActive;
  const title = full
    ? 'Finish an active tile'
    : activeCount > 0
      ? 'Continue an active tile, or claim another'
      : 'Claim a square in enemy waters';
  // Over, not merely full. Nothing produces this any more — a revoke parks the
  // claim instead of handing it back, and the limit trigger now covers UPDATE
  // as well as INSERT — but claims made before that fix can still be over, and
  // "All 3 slots are in use" while holding four reads as a bug.
  const detail = activeCount > maxActive
    ? `You are holding ${activeCount} tiles, over the usual limit of ${maxActive}. Finish one before claiming again.`
    : full
    ? `All ${maxActive} active slots are in use. Upload the required evidence, then fire a shot.`
    : activeCount > 0
      ? `${activeCount} of ${maxActive} active slots are in progress. ${canClaim ? 'You can still claim another square.' : 'Complete one before taking another.'}`
      : 'Choose a coordinate on Enemy waters to reveal its task and reserve the slot for your team.';

  return (
    <section className="next-move" aria-label="Your next move">
      <div>
        <span className="eyebrow">Your next move</span>
        <h2>{title}</h2>
      </div>
      <p>{detail}</p>
    </section>
  );
}
