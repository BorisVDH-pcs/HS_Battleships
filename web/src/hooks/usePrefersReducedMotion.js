import { useEffect, useState } from 'react';

/**
 * Whether the OS has been asked to reduce motion.
 *
 * The stylesheet already answers this for anything CSS animates — one blanket
 * rule flattens every keyframe and transition in the app. What it cannot reach
 * is motion baked into a file: the cannon gif animates itself, and no CSS
 * property will stop it. That is what this is for.
 *
 * Subscribed rather than read once, because the setting is a toggle in the OS
 * and someone turning it on mid-event should not have to reload the board to
 * be taken at their word.
 */
const QUERY = '(prefers-reduced-motion: reduce)';

export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.(QUERY).matches ?? false
  );

  useEffect(() => {
    const mq = window.matchMedia?.(QUERY);
    if (!mq) return undefined;
    const onChange = (e) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    // The query can have changed between the initial read above and this
    // subscription -- rare, but the fix is one line.
    setReduced(mq.matches);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
