import { useEffect, useState } from 'react';
import { GIF_DURATION_MS } from '../lib/fireEffect.js';

// BASE_URL, not a leading slash: the site is served from /HS_Battleships/.
const CANNON_GIF = `${import.meta.env.BASE_URL}audio/boom-cannon.gif`;
const SOUND_BY_RESULT = {
  hit: `${import.meta.env.BASE_URL}audio/kaboooom.mp3`,
  miss: `${import.meta.env.BASE_URL}audio/sploosh.mp3`,
};

// Fallback if the sound fails to load/play — keeps the effect from getting
// stuck on screen forever.
const SOUND_FALLBACK_MS = 2000;

/**
 * The cannon-fire flourish for a resolved shot. `shot` is `{ nonce, result }`
 * — the nonce changes on every fire so back-to-back shots with the same
 * result still replay instead of no-opping on unchanged state.
 *
 * Sequenced, not simultaneous: the gif plays alone first, then — right as it
 * finishes — the hit/miss sound starts. useGame.js delays its tile-reveal
 * refetch by the same GIF_DURATION_MS, so the tile flips at the same instant
 * the sound starts rather than while the cannon is still firing.
 */
export default function FireEffect({ shot }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!shot) return undefined;
    setVisible(true);

    const timers = [];
    timers.push(setTimeout(() => {
      const sound = SOUND_BY_RESULT[shot.result];
      if (!sound) {
        setVisible(false);
        return;
      }
      const audio = new Audio(sound);
      audio.addEventListener('ended', () => setVisible(false));
      audio.play().catch(() => setVisible(false));
      timers.push(setTimeout(() => setVisible(false), SOUND_FALLBACK_MS));
    }, GIF_DURATION_MS));

    return () => timers.forEach(clearTimeout);
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
