import { useEffect, useState } from 'react';

// BASE_URL, not a leading slash: the site is served from /HS_Battleships/.
const CANNON_GIF = `${import.meta.env.BASE_URL}audio/boom-cannon.gif`;
const SOUND_BY_RESULT = {
  hit: `${import.meta.env.BASE_URL}audio/kaboooom.mp3`,
  miss: `${import.meta.env.BASE_URL}audio/sploosh.mp3`,
};

// Long enough to read the cannon animation and let either sound finish;
// short enough not to block the next shot.
const VISIBLE_MS = 1600;

/**
 * The cannon-fire flourish for a resolved shot. `shot` is `{ nonce, result }`
 * — the nonce changes on every fire so back-to-back shots with the same
 * result still replay instead of no-opping on unchanged state.
 */
export default function FireEffect({ shot }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!shot) return undefined;
    setVisible(true);
    const sound = SOUND_BY_RESULT[shot.result];
    if (sound) new Audio(sound).play().catch(() => {});
    const timer = setTimeout(() => setVisible(false), VISIBLE_MS);
    return () => clearTimeout(timer);
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
