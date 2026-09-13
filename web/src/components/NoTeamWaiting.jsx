import { useCountdown, pad } from '../lib/countdown.js';

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
});

/**
 * The full-screen holding pen: for a player with no team yet, and — once a
 * game has a scheduled `starts_at` — for one who has a team but whose game
 * has not been opened for placement yet. `assigned` only changes the copy;
 * the countdown itself is identical, because neither case has anything to
 * click on the board yet.
 */
export default function NoTeamWaiting({ gameName, startsAt, assigned = false, teamName }) {
  const remaining = useCountdown(startsAt);

  const units = [
    ['days', remaining.days, 'Days'],
    ['hours', remaining.hours, 'Hours'],
    ['minutes', remaining.minutes, 'Minutes'],
    ['seconds', remaining.seconds, 'Seconds'],
  ];

  return (
    <section className="waiting" aria-labelledby="waiting-title">
      <div className="waiting-radar" aria-hidden="true"><span /></div>
      <h1 id="waiting-title">Please await orders</h1>
      {gameName && <p className="waiting-game">{gameName}</p>}
      <p className="waiting-lead">
        {assigned
          ? `You're aboard ${teamName ?? 'your team'}. Keep this channel open — the board opens once an admin gives the order.`
          : "You haven't been placed on a team yet. An admin will assign you once the teams are formed."}
      </p>
      {remaining.set && (
        <div className="countdown" aria-live="polite" aria-label={remaining.started ? 'The battle has started' : `Battle begins in ${remaining.days} days, ${remaining.hours} hours, ${remaining.minutes} minutes, and ${remaining.seconds} seconds`}>
          {units.map(([key, value, label]) => (
            <div className="countdown-unit" key={key}>
              <span className="countdown-value">{key === 'days' ? value : pad(value)}</span>
              <span className="countdown-label">{label}</span>
            </div>
          ))}
        </div>
      )}
      <p className="waiting-launch">
        <span className="launch-marker" aria-hidden="true">◆</span>
        {!remaining.set
          ? 'An admin will announce a start time soon.'
          : remaining.started
            ? 'Standing by for the order to start.'
            : `Battle stations open ${DATE_FORMAT.format(new Date(startsAt))}`}
      </p>
    </section>
  );
}
