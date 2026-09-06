import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { tileProgress } from '../lib/tileProgress.js';

/** What the list behind the "?" is a list OF, per completion rule (0049). */
const HEADINGS = {
  points: 'Drops that count — any mix adding up to the target',
  one_set: 'Complete any one of these sets',
  each_set: 'Collect from each of these',
};

/** Breathing room between the panel and the edge of the window. */
const MARGIN = 8;
/** Gap between the badge and the panel. */
const OFFSET = 7;

/**
 * The "?" beside a tile's name, and everything that explains that tile.
 *
 * Two things live behind it. The first is the organiser's small print from the
 * V4 sheet — which drops from a boss are on the list, whether duplicates count,
 * what "a set" means on that square. It is exactly the thing a team asks in
 * Discord halfway through a tile, so it belongs on the card they are looking at
 * while they work it.
 *
 * The second is the price list for a weighted tile (0046). That used to sit
 * open on the card itself, which was fine for a tile pricing three drops and
 * unusable for one pricing thirty-eight: the list pushed the drop zone off the
 * bottom of the column. It is reference material — you read it once to plan the
 * tile, then you want it gone — so it belongs behind a disclosure. Nothing is
 * lost by hiding it, because the per-file picker on the card still names the
 * points beside every option at the moment of choosing.
 *
 * Hover AND click, not one or the other. Hover is the cheaper gesture on a
 * mouse and this is a glance, not a destination — but hover does not exist on a
 * phone, and a fair number of players are reading the board on one. So a click
 * PINS the panel open and a second click closes it, while hovering only peeks:
 * leaving with the mouse closes a peeked panel and leaves a pinned one alone.
 * Without that split, moving the mouse away after clicking would shut a panel
 * the player had deliberately opened. Pinning is also what makes a long price
 * list usable, since scrolling it means leaving the badge.
 *
 * `tiles_for_me()` redacts both `description` and `options` for any tile the
 * team has not claimed (0046, 0048), so a tile with nothing to say — and every
 * tile belonging to anybody else — renders no button at all. There is no empty
 * "?" to click.
 */
export default function TileInfo({ tile }) {
  const [pinned, setPinned] = useState(false);
  const [peeked, setPeeked] = useState(false);
  const [at, setAt] = useState(null);
  const wrapRef = useRef(null);
  const btnRef = useRef(null);
  const panelRef = useRef(null);

  const text = tile.description;
  const tileName = tile.name;
  const options = tile.options ?? [];
  const rule = tile.completion ?? 'points';
  const { groups } = tileProgress(tile);

  const open = pinned || peeked;
  const hasText = Boolean(text);
  const hasOptions = options.length > 0;

  // Placed in script, and fixed to the window rather than absolute to the
  // badge, because CSS alone cannot keep a panel inside the viewport. The
  // active tiles live in a narrow column pinned to one side of the board, so a
  // panel that always opens the same way runs off the screen on that side —
  // right-aligned to the badge, the 320px panel started at x=-67 in the
  // left-hand layout and simply could not be read. This measures and flips.
  useLayoutEffect(() => {
    if (!open) { setAt(null); return undefined; }

    function place() {
      const btn = btnRef.current;
      const panel = panelRef.current;
      if (!btn || !panel) return;
      const b = btn.getBoundingClientRect();
      const { offsetWidth: w, offsetHeight: h } = panel;

      // Right-aligned to the badge by preference — the badge sits at the right
      // of the card, so the panel opens back across the tile it describes —
      // then slid whichever way it has to go to stay on screen.
      let left = b.right - w;
      left = Math.min(left, window.innerWidth - MARGIN - w);
      left = Math.max(MARGIN, left);

      // Below by preference, above if the price list will not fit below, and
      // failing both, parked against the bottom: the panel scrolls internally,
      // so being pinned to an edge still shows all of it.
      let top = b.bottom + OFFSET;
      if (top + h > window.innerHeight - MARGIN) {
        const above = b.top - OFFSET - h;
        top = above >= MARGIN ? above : Math.max(MARGIN, window.innerHeight - MARGIN - h);
      }
      setAt({ left, top });
    }

    place();
    // Capture, so the side column's own scrolling moves the panel with its
    // badge and not just the window's.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, text, options]);

  // A pinned panel is dismissed the two ways any transient surface is: Escape,
  // and a click elsewhere. Only wired up while something is pinned, so the
  // board is not carrying a document listener per tile the rest of the time.
  useEffect(() => {
    if (!pinned) return undefined;
    function onKey(e) { if (e.key === 'Escape') setPinned(false); }
    function onDown(e) {
      // Both, because the panel is portaled out of the wrapper: a press inside
      // it — grabbing the price list's scrollbar — is not an outside click.
      if (wrapRef.current?.contains(e.target)) return;
      if (panelRef.current?.contains(e.target)) return;
      setPinned(false);
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [pinned]);

  if (!hasText && !hasOptions) return null;

  return (
    <span
      className="tile-info"
      ref={wrapRef}
      onMouseEnter={() => setPeeked(true)}
      onMouseLeave={() => setPeeked(false)}
    >
      <button
        type="button"
        ref={btnRef}
        className={`tile-info-btn${open ? ' open' : ''}`}
        aria-expanded={open}
        aria-label={`What counts for ${tileName}`}
        // The card underneath uses a click to choose the paste target, and the
        // outside-click handler above would see this very click bubble back up
        // and close the panel it just opened. Stopped on both counts.
        onClick={(e) => { e.stopPropagation(); setPinned((p) => !p); }}
        // Keyboard users get the same panel from focus, and lose it on blur —
        // but only if they have not pinned it with Enter or Space.
        onFocus={() => setPeeked(true)}
        onBlur={() => setPeeked(false)}
      >
        ?
      </button>

      {open && createPortal(
        // Portaled to <body>, not left in the card. The active-tile column is a
        // blurred material — `backdrop-filter` — and that makes the column the
        // containing block for `position: fixed` descendants AND its own
        // stacking context. In place, the panel was measured against the column
        // instead of the window and painted underneath the cards it was meant
        // to sit over. Out here it is a plain overlay against the viewport.
        //
        // Clicks inside a pinned panel — grabbing the price list's scrollbar,
        // mostly — must not select the card underneath or reach the dismiss
        // handler, hence the stopPropagation. The mouse handlers keep a peeked
        // panel alive while the pointer is over it, which the wrapper's own
        // mouseleave can no longer do now that the panel is not inside it.
        <span
          className="tile-info-panel"
          role="tooltip"
          ref={panelRef}
          onMouseEnter={() => setPeeked(true)}
          onMouseLeave={() => setPeeked(false)}
          // Hidden for the one frame between mounting at natural size — which
          // is what the measurement above needs — and being placed. Without it
          // the panel flashes at the top-left corner of the window first.
          style={at
            ? { left: `${at.left}px`, top: `${at.top}px` }
            : { left: 0, top: 0, visibility: 'hidden' }}
          onClick={(e) => e.stopPropagation()}
        >
          {hasText && <span className="tile-info-text">{text}</span>}

          {hasOptions && (
            <>
              {/* Named rather than left as a bare list: on a tile that also has
                  small print, the two blocks are different kinds of thing and
                  ran together without a heading. */}
              <span className="tile-info-heading">
                {HEADINGS[rule] ?? HEADINGS.points}
                {rule === 'each_set' && (tile.per_set ?? 1) > 1
                  && ` — ${tile.per_set} different from each`}
              </span>

              {/* One flat list when nothing is grouped, a sub-list per set when
                  something is. The tick is the whole reason the sets are drawn
                  here rather than only in the picker: it answers "which of
                  these do we already have" without opening a dropdown. */}
              {groups.map((g) => (
                <div key={g.name} className="tile-info-group">
                  {g.named && (
                    <span className="tile-info-set">
                      {g.name}
                      <span className="tile-info-pts">{g.taken} / {g.need ?? g.total}</span>
                    </span>
                  )}
                  <ul className="tile-info-options">
                    {g.options.map((o) => (
                      <li key={o.id} className={o.taken ? 'taken' : undefined}>
                        <span>{o.taken ? '✓ ' : ''}{o.label}</span>
                        {rule === 'points' && (
                          <span className="tile-info-pts">{o.points} pts</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </>
          )}
        </span>,
        document.body
      )}
    </span>
  );
}
