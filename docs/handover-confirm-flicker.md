# Handover — flickering confirm dialog ("Fire the shot?")

Session date: 2026-09-06. Status: **FIXED** in `web/src/styles.css` — see "The fix
applied" below. No game data was written at any point.

## The symptom

Submitting the last piece of evidence for a tile raises the `ConfirmDialog`
("Fire the shot?" / Cancel / **Submit & fire**). While that dialog is open,
moving the mouse over the board behind it makes **the dialog itself flicker**.

It is the dialog that flickers — not the board, and not any tooltip. Boris
confirmed this by screenshot after the two wrong guesses below were eliminated.

## What was ruled out, and how

Do not re-investigate these; each was tested live in the running app.

1. **The board grid.** A `MutationObserver` on `.board-grid`
   (`childList` + `attributes`) recorded **zero** mutations while sweeping the
   mouse across the cells. Hover on the board is pure CSS and triggers no React
   re-render. `EnemyGrid` is not involved.

2. **The `.shot-result` HIT!/MISS! badge.** Replicated its exact post-fire DOM
   on the live board and measured it: the badge renders *inside* the cell
   (badge 40.7px wide vs cell 39.0px — ~1px overhang), so it never overlaps
   neighbouring cells and cannot be occluded by them.

3. **The `TileInfo` "?" panel.** A `childList` observer on `document.body`
   during a real reproduction logged nothing — no mount/unmount loop. (There
   *is* a latent hazard here; see "Also found" below. It is not this bug.)

4. **The native `title` tooltip.** Boris stripped every `title` off the board
   with `document.querySelectorAll('.board-grid [title]').forEach(el =>
   el.removeAttribute('title'))` and the flicker continued.

## The cause

`web/src/styles.css` — **two nested `backdrop-filter` layers**:

- `.confirm-backdrop` (line ~2028): `backdrop-filter: blur(8px)`, `position:
  fixed; inset: 0; z-index: 50`
- `.confirm` (line ~2043), its **direct child**: `backdrop-filter: blur(40px)
  saturate(180%)`

A `backdrop-filter` nested inside another `backdrop-filter` forces the inner
element to sample the *already-blurred* output of the outer one. Chromium
recomputes that whole composited region on pointer movement over the layer,
which presents as flicker. This is a known Chromium compositing behaviour, not
a React problem — consistent with the DOM being completely static throughout.

A likely aggravating second factor on the same element: `@keyframes confirm-in`
animates `filter: blur(6px) → blur(0)` on `.confirm`, and `filter` +
`backdrop-filter` on one element is an independent known flicker trigger. That
animation only runs for 0.34s, so it cannot explain flicker that persists —
treat it as secondary.

**The same nested pair exists for the guide dialog** at lines ~2122 (`blur(8px)`
scrim) and ~2132 (`blur(40px)` sheet). Whatever fix is chosen should be applied
to both.

## Next step — confirm before fixing

With the dialog open and flickering, in the console:

```js
document.querySelector('.confirm').style.backdropFilter = 'none';
```

If the flicker stops, the nesting is confirmed. If it does not, try the scrim
instead: `document.querySelector('.confirm-backdrop').style.backdropFilter = 'none'`.

## Candidate fixes (in preference order)

1. **Drop the inner blur.** Give `.confirm` a solid or near-solid background
   (`var(--panel-solid)`) and remove its `backdrop-filter`. The scrim behind it
   is already blurring the page, so the sheet's own 40px blur is sampling an
   8px-blurred field — visually it is buying very little for its cost.
2. **Drop the outer blur.** Keep the sheet's material, make `.confirm-backdrop`
   a plain `rgba(0,0,0,.6)` dim with no `backdrop-filter`.
3. **Promote the sheet to its own layer** with `will-change: backdrop-filter` or
   `transform: translateZ(0)`. Cheapest to try, least reliable — this is
   papering over a compositing bug rather than removing the nesting.

Option 1 preserves the most of the intended design language. Whichever is
chosen, mirror it onto `.guide-backdrop` / the guide sheet.

Note there is already a `prefers-reduced-motion` branch at line ~1961 that sets
`.confirm-backdrop, .guide-backdrop { backdrop-filter: none }` — so the
"no blur" path is already a supported look in this stylesheet.

## Also found (unrelated, both real, neither is this bug)

- **`styles.css:1799`** — `button.cell.clickable:hover` sets `z-index: 1`,
  specificity 0-3-1, which overrides `.cell.result-feedback`'s `z-index: 4`
  (specificity 0-2-0) at `styles.css:507`. Verified live: hovering a fired
  square drops it from 4 to 1. Cosmetically inert today, because the badge sits
  inside its cell (see ruled-out item 2) and z-index 1 still paints above the
  `auto` siblings. Worth tightening if the badge is ever widened.

- **`TileInfo.jsx`** — `peeked` is written by two competing handler pairs: the
  wrapper's `onMouseEnter`/`onMouseLeave` (line 138) and the portaled panel's
  own (line 176). Because the panel is portaled to `<body>` it is not a DOM
  descendant of the wrapper, so when the panel overlaps its own "?" button both
  `mouseleave` (→ false) and `mouseenter` (→ true) fire on the same move, and
  the outcome depends on their order. The panel genuinely can cover its button
  via the "parked against the bottom" fallback at `TileInfo.jsx:95` — confirmed
  live at a 894x430 viewport, where the panel spanned y 120–422 with its button
  at y 206–224, fully underneath. Never observed to actually loop. Latent.

## Environment notes for the next session

- Dev server on **port 5174** was already running from another session;
  `preview_start` refuses the port. Just `navigate` to `http://localhost:5174/`
  in a new tab — the in-app browser **shares the logged-in Supabase session**
  (`localStorage['sb-fjgcijmdxeebgkdokini-auth-token']`).
- Boris was signed in as **Soft Papi**, Demo Alpha, in "Demo Match".
- Both of Soft Papi's active tiles (A5, E8) still need more evidence, so a real
  shot cannot be fired without uploading screenshots first. That is why the
  post-fire state was replicated in the DOM rather than triggered for real.

## The fix applied

Option 1 from the list above, on both nested pairs:

- `.confirm` — dropped `backdrop-filter: blur(40px) saturate(180%)` (and the
  `-webkit-` twin), and swapped `background: rgba(36, 36, 38, .82)` for the
  opaque `var(--panel-solid)`.
- `.guide-welcome-card, .guide-card` — same change, from
  `rgba(36, 36, 38, .86)`.

Both scrims keep their own `blur(8px)`, so the page still blurs behind the
sheet; only the redundant second blur is gone. A comment at each site records
why, so nobody restores it.

`.guide-tour-card` (line ~2249) still has `blur(40px)` and was deliberately left
alone: it is `position: fixed; z-index: 75`, a sibling of `.guide-backdrop`
rather than a child of it (`Guide.jsx:257` vs `:278`), so it is not nested
inside another `backdrop-filter` and is not affected.

The `@keyframes confirm-in` `filter: blur(6px) → 0` was left in place. It was
only ever a suspected aggravator via `filter` + `backdrop-filter` on one
element; with the `backdrop-filter` gone that combination no longer exists.

Verified live: `.confirm` computes to `backdrop-filter: none`,
`background: rgb(28, 28, 30)`, scrim still `blur(8px)`, and a real "Lock in J1"
dialog rendered correctly on the blurred board (then cancelled — no write).

**Still worth doing:** Boris should reproduce the original "Fire the shot?"
flow once and sweep the mouse over the board to confirm the flicker is gone.
That specific dialog was not reproducible from this session's account, because
neither active tile had enough evidence to trigger it.

---

# Round two — the flicker that survived (2026-09-06)

Boris reported the flicker was still there, but only on **submit and fire**:
the dialog looked like it wanted to open "both on top of the submission box and
over the board", the two fighting each other.

That is the case the note above ended on: the "Fire the shot?" dialog was never
reproduced live, because neither of the test account's active tiles had enough
evidence to raise it. The nested-blur fix was real, but it was not the only
cause — and the second cause affects **only** the dialogs raised from inside a
slot, which is exactly the one that could not be tested.

## Second cause: a containing block that moves

`useConfirm()` returned the dialog as plain JSX, and every call site rendered it
where it was raised. For `EvidenceUploader` that is
`.side-col > .active-tiles > .slots > .slot.filled > .evidence` — and two
properties on that chain capture `position: fixed`:

| Selector | Property | Effect |
| --- | --- | --- |
| `.side-col .active-tiles` (styles.css:685) | `backdrop-filter: blur(30px)` | Permanent containing block **and** stacking context |
| `.slot:not(.empty):hover` (styles.css:804) | `transform: translateY(-2px)` | Containing block that appears and disappears with the pointer |

A `backdrop-filter` or a `transform` on an ancestor makes that ancestor the
containing block for `position: fixed` descendants. So `.confirm-backdrop`
(`position: fixed; inset: 0`) was never measured against the window — it was
measured against the card. Worse, the hover transform means the containing
block **changes** as the pointer moves, over a `.28s` transition. Measured
live against the real stylesheet, at a 1280x800 viewport:

```
BEFORE  rest     318x198 @ 41,101     <- the .active-tiles column's box
BEFORE  hover    284x166 @ 58,117     <- jumps to the .slot padding box
BEFORE  unhover  318x198 @ 41,101     <- jumps back

AFTER   rest    1280x800 @ 0,0
AFTER   hover   1280x800 @ 0,0
AFTER   unhover 1280x800 @ 0,0
```

Every pass of the mouse across the card moved the sheet 17px right, 16px down
and shrank it by 34x32. That is the flicker, and it is why it read as two
positions fighting: the dialog really was being laid out against two different
boxes, a third of a second apart.

The column being its own stacking context is the same story from the other
side — `z-index: 50` on the scrim only ever competed *within* the column, so it
could not cover the board no matter how high it went.

## The fix

`ConfirmDialog` now portals to `<body>` (`createPortal`), the way `TileInfo`
already did for the same reason — its comment at `TileInfo.jsx:159` describes
this exact failure for the price-list panel. Out at the body there is no
ancestor able to reposition, clip or re-stack the sheet, and no outer
`backdrop-filter` left for the scrim's own `blur(8px)` to nest inside.

One change in `ConfirmDialog.jsx` fixes every call site at once, including
`ActiveTiles`' own "Lock in" / "Complete & fire" confirms — those render at
`.active-tiles` level, so they had the column's containing block too (though
not the hover flip, which is why they looked steadier).

React portals still propagate events through the React tree, not the DOM tree,
so the backdrop's click-outside-to-cancel and the slot's click-to-select-paste
-target behave exactly as before. Nothing at the call sites changed.

Verified: `npm run build` clean (104 modules), no console errors on load, and
the measurements above taken against the app's own stylesheet.
