import { useEffect, useState } from 'react';

/**
 * Ticks down to `targetIso` once a second. `started` clamps at the target
 * rather than going negative, because an admin who is not ready yet leaves
 * the clock sitting at zero rather than counting up past it — the countdown
 * is a target time to aim for, not a guarantee of when the board unlocks.
 */
export function useCountdown(targetIso) {
  const target = targetIso ? Date.parse(targetIso) : null;
  const [remaining, setRemaining] = useState(() => remainingParts(target));

  useEffect(() => {
    setRemaining(remainingParts(target));
    if (target === null) return undefined;
    const timer = window.setInterval(() => setRemaining(remainingParts(target)), 1000);
    return () => window.clearInterval(timer);
  }, [target]);

  return remaining;
}

function remainingParts(target) {
  if (target === null) return { days: 0, hours: 0, minutes: 0, seconds: 0, started: false, set: false };
  const totalSeconds = Math.max(0, Math.floor((target - Date.now()) / 1000));
  return {
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    started: totalSeconds === 0,
    set: true,
  };
}

export function pad(value) {
  return String(value).padStart(2, '0');
}
