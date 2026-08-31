import { useState } from 'react';

/**
 * The clan logo, with the gold CSS wordmark as its fallback.
 *
 * The artwork is deliberately not committed: it is the clan's, it is large,
 * and the same file is wanted by HighSocietyScape, which keeps it out of its
 * repo for the same reason. Drop it at `web/public/logo.png` and every place
 * this component is used picks it up. Until then the wordmark stands in, so a
 * missing file costs nothing and never shows a broken image.
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
