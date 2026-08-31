import { useState } from 'react';

/**
 * The clan logo, with the gold CSS wordmark as its fallback.
 *
 * `public/logo.png` is derived from the master at the repo root by
 * `tools/make_logo.py` — cropped, keyed to transparency and scaled down from
 * 2.6 MB, which is not a thing to send a player on a phone. The CSS fallback
 * stays because a logo that fails to load should cost nothing: the header
 * degrades to the gold wordmark rather than a broken image.
 */
export default function Wordmark({ subtitle = 'Battleships' }) {
  const [failed, setFailed] = useState(false);

  if (failed) return <h1>HS {subtitle}</h1>;

  return (
    <h1 className="wordmark">
      {/* BASE_URL, not a leading slash — the site is served from
          /HS_Battleships/ in production. Same rule as TileIcon. */}
      <img
        src={`${import.meta.env.BASE_URL}logo.png`}
        alt="High Society"
        onError={() => setFailed(true)}
        draggable="false"
      />
      <span className="sub">{subtitle}</span>
    </h1>
  );
}
