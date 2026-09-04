// Frame-counted from boom-cannon.gif (29 frames at 100ms each) — the moment
// the animation's last frame has shown, not a guess.
export const GIF_DURATION_MS = 2900;

// A beat of empty board after the gif vanishes and before the hit/miss lands
// — without it the reveal reads as part of the same motion as the cannon
// firing instead of its own, separate event.
export const POST_GIF_PAUSE_MS = 400;

// Shared so the tile reveal (useGame.js) and the hit/miss sound
// (FireEffect.jsx) land at the same instant: gif, then a pause, then both
// together.
export const REVEAL_DELAY_MS = GIF_DURATION_MS + POST_GIF_PAUSE_MS;
