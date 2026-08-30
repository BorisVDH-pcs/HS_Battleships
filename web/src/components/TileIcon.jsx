import { useState } from 'react';

/**
 * A tile's icon, with the coordinate as the fallback.
 *
 * `slug` is null for any tile this team has not claimed — `tiles_for_me()`
 * redacts it exactly as it redacts the name. That redaction is also why the
 * images cannot leak: with no slug there is no filename, so an unclaimed tile
 * produces no request and shows up nowhere in the network log.
 *
 * A missing file falls back to the coordinate rather than a broken-image icon,
 * so half-finished artwork degrades to the board we have today.
 */
export default function TileIcon({ slug, fallback }) {
  const [failed, setFailed] = useState(false);
  if (!slug || failed) return fallback;

  // BASE_URL, not a leading slash: the site is served from /HS_Battleships/.
  return (
    <img
      className="tile-icon"
      src={`${import.meta.env.BASE_URL}icons/${slug}.png`}
      alt=""
      loading="lazy"
      draggable="false"
      onError={() => setFailed(true)}
    />
  );
}
