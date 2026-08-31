import { useState } from 'react';

/**
 * A tile's icon, with a stand-in behind it and the coordinate behind that.
 *
 * `slug` is null for any tile this team has not claimed — `tiles_for_me()`
 * redacts it exactly as it redacts the name. That redaction is also why the
 * images cannot leak: with no slug there is no filename, so an unclaimed tile
 * produces no request and shows up nowhere in the network log. `standIn` is
 * what separates the two reasons a slug can be missing: an unclaimed tile has
 * none because it is secret, a claimed one because nobody has drawn it yet.
 *
 * Ten of the ninety tiles have artwork so far, so most claimed tiles would
 * otherwise fall back to a coordinate and look exactly like the unclaimed ones
 * around them. They borrow the dragon warhammer instead: obviously a
 * placeholder once real art lands beside it, and until then the board reads as
 * a board of items.
 *
 * The coordinate is still the last resort, so a missing icons folder degrades
 * to the grid we had before any artwork existed.
 */
const PLACEHOLDER = 'dragon_warhammer';

export default function TileIcon({ slug, fallback, standIn = false }) {
  // Which candidate files have 404'd, remembered against the file they belong
  // to: React reuses this component across cells, so a failure must not follow
  // it onto the next tile.
  const [failed, setFailed] = useState({ key: null, own: false, stand: false });

  const primary = slug ?? (standIn ? PLACEHOLDER : null);
  if (!primary) return fallback;

  const f = failed.key === primary ? failed : { key: primary, own: false, stand: false };
  const secondary = standIn && primary !== PLACEHOLDER ? PLACEHOLDER : null;
  const name = !f.own ? primary : (secondary && !f.stand ? secondary : null);
  if (!name) return fallback;

  return (
    <img
      // Keyed so swapping to the stand-in actually reloads, rather than
      // leaving the browser's broken-image state on the same element.
      key={name}
      className={`tile-icon${name === PLACEHOLDER && slug ? ' stand-in' : ''}`}
      // BASE_URL, not a leading slash: the site is served from /HS_Battleships/.
      src={`${import.meta.env.BASE_URL}icons/${name}.png`}
      alt=""
      loading="lazy"
      draggable="false"
      onError={() => setFailed({ ...f, [f.own ? 'stand' : 'own']: true })}
    />
  );
}
