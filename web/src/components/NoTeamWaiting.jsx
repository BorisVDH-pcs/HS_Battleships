import { useEffect, useState } from 'react';

// The event time is explicitly CET (UTC+01:00), rather than the browser's
// local timezone, so every player sees the same launch moment.
const START_TIME = Date.parse('2026-09-25T19:00:00+01:00');

function remainingParts() {
  const totalSeconds = Math.max(0, Math.floor((START_TIME - Date.now()) / 1000));
  return {
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    started: totalSeconds === 0,
  };
}

function pad(value) {
  return String(value).padStart(2, '0');
}

export default function NoTeamWaiting({ displayName }) {
  const [remaining, setRemaining] = useState(remainingParts);

  useEffect(() => {
    const timer = window.setInterval(() => setRemaining(remainingParts()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const units = [
    ['days', remaining.days, 'Days'],
    ['hours', remaining.hours, 'Hours'],
    ['minutes', remaining.minutes, 'Minutes'],
    ['seconds', remaining.seconds, 'Seconds'],
  ];

  return (
    <section className="waiting" aria-labelledby="waiting-title">
      <div className="waiting-radar" aria-hidden="true"><span /></div>
      <p className="waiting-kicker">Fleet assembly in progress</p>
      <h1 id="waiting-title">Please await orders</h1>
      <p className="waiting-lead">
        You are not assigned to a team yet. Keep this channel open — an admin
        will place you aboard automatically.
      </p>
      <div className="countdown" aria-live="polite" aria-label={remaining.started ? 'The battle has started' : `Battle begins in ${remaining.days} days, ${remaining.hours} hours, ${remaining.minutes} minutes, and ${remaining.seconds} seconds`}>
        {units.map(([key, value, label]) => (
          <div className="countdown-unit" key={key}>
            <span className="countdown-value">{key === 'days' ? value : pad(value)}</span>
            <span className="countdown-label">{label}</span>
          </div>
        ))}
      </div>
      <p className="waiting-launch">
        <span className="launch-marker" aria-hidden="true">◆</span>
        {remaining.started ? 'The battle is underway.' : 'Battle stations open Friday 25 September · 19:00 CET'}
      </p>
      <p className="muted">Signed in as <strong>{displayName}</strong></p>
    </section>
  );
}
