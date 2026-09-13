import { useCountdown, pad } from '../lib/countdown.js';

/**
 * A one-line reminder during placement: fleets can be arranged early, but the
 * scheduled time is still worth keeping in view while doing it. Renders
 * nothing once a game has no `starts_at` set — a game without one gives this
 * nothing true to say.
 */
export default function StartTimeBadge({ startsAt }) {
  const remaining = useCountdown(startsAt);
  if (!remaining.set) return null;

  return (
    <p className="start-time-badge">
      {remaining.started
        ? 'Battle stations: waiting on an admin to start'
        : `Battle stations in ${remaining.days > 0 ? `${remaining.days}d ` : ''}${pad(remaining.hours)}:${pad(remaining.minutes)}:${pad(remaining.seconds)}`}
    </p>
  );
}
