import { useEffect, useState } from 'react';
import { GIF_DURATION_MS } from '../lib/fireEffect.js';

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
 *   3. The tile flips to its hit/miss color and the hit/miss sound plays,
 *      both at that same instant.
 * Step 3's board flip isn't driven from here — useGame.js delays its
 * tile-reveal refetch by the same GIF_DURATION_MS, so it lands in sync with
 * the sound below without the two components needing to talk to each other.
 */
export default function FireEffect({ shot }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!shot) return undefined;
    setVisible(true);

    const cannon = new Audio(CANNON_SOUND);
    cannon.play().catch(() => {});

    const timer = setTimeout(() => {
      setVisible(false);
      const sound = SOUND_BY_RESULT[shot.result];
      if (sound) new Audio(sound).play().catch(() => {});
    }, GIF_DURATION_MS);

    return () => {
      clearTimeout(timer);
      cannon.pause();
    };
  }, [shot]);

  if (!visible || !shot) return null;

  return (
    <div className="fire-effect" aria-hidden="true">
      {/* Keyed on the nonce so the gif restarts from its first frame on every
          shot rather than freezing on the last frame of the previous one. */}
      <img key={shot.nonce} src={CANNON_GIF} alt="" />
    </div>
  );
}
