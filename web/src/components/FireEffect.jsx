import { useEffect, useRef, useState } from 'react';
import { GIF_DURATION_MS, REVEAL_DELAY_MS } from '../lib/fireEffect.js';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion.js';

// BASE_URL, not a leading slash: the site is served from /HS_Battleships/.
const CANNON_GIF = `${import.meta.env.BASE_URL}audio/boom-cannon.gif`;
const CANNON_SOUND = `${import.meta.env.BASE_URL}audio/cannon.mp3`;
const SOUND_BY_RESULT = {
  hit: `${import.meta.env.BASE_URL}audio/kaboooom.mp3`,
  miss: `${import.meta.env.BASE_URL}audio/sploosh.mp3`,
};

/**
 * The cannon-fire flourish for a resolved shot. `shot` is `{ nonce, result }`
 * — the nonce changes on every fire so back-to-back shots with the same
 * result still replay instead of no-opping on unchanged state.
 *
 * Sequenced, not simultaneous:
 *   1. The gif plays one round (GIF_DURATION_MS, measured off its own 29
 *      frames) with the cannon-fire sound under it. Nothing else happens.
 *   2. The gif disappears.
 *   3. A short beat of empty board (POST_GIF_PAUSE_MS), then the tile flips
 *      to its hit/miss color and the hit/miss sound plays, both together.
 * Step 3's board flip isn't driven from here — useGame.js delays its
 * tile-reveal refetch by the same REVEAL_DELAY_MS, so it lands in sync with
 * the sound below without the two components needing to talk to each other.
 */
export default function FireEffect({ shot, muted = false }) {
  const [visible, setVisible] = useState(false);
  const reducedMotion = usePrefersReducedMotion();

  // Read through a ref rather than taken as a dependency: re-running the
  // effect because the toggle moved would replay the whole flourish from the
  // top, and muting mid-shot should quieten the rest of it, not restart it.
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  useEffect(() => {
    if (!shot) return undefined;
    setVisible(true);

    // A muted shot keeps every one of its timings. The board reveal is
    // choreographed against them in useGame.js, and it neither knows nor cares
    // whether any of it was audible.
    const cannon = new Audio(CANNON_SOUND);
    if (!mutedRef.current) cannon.play().catch(() => {});

    const hideTimer = setTimeout(() => setVisible(false), GIF_DURATION_MS);
    const soundTimer = setTimeout(() => {
      if (mutedRef.current) return;
      const sound = SOUND_BY_RESULT[shot.result];
      if (sound) new Audio(sound).play().catch(() => {});
    }, REVEAL_DELAY_MS);

    return () => {
      clearTimeout(hideTimer);
      clearTimeout(soundTimer);
      cannon.pause();
    };
  }, [shot]);

  if (!visible || !shot) return null;

  // The gif animates itself, so the blanket reduced-motion rule in the
  // stylesheet cannot reach it the way it reaches every other flourish here.
  // Someone who asked for less motion gets the same beat and the same sound
  // with a still mark in place of the explosion.
  return (
    <div className="fire-effect" aria-hidden="true">
      {reducedMotion ? (
        <span className="fire-effect-still">✸</span>
      ) : (
        /* Keyed on the nonce so the gif restarts from its first frame on every
           shot rather than freezing on the last frame of the previous one. */
        <img key={shot.nonce} src={CANNON_GIF} alt="" />
      )}
    </div>
  );
}
