/**
 * Whether the cannon is allowed to make a noise.
 *
 * Not per user, unlike the game pick: this is a property of the room the
 * browser is in — an office, a stream, a Discord call already carrying the
 * event's audio — and it should hold across a sign-out on that machine rather
 * than resetting to loud for whoever signs in next.
 *
 * Sound is on by default. The shot flourish is most of what makes a fire feel
 * like one, and a clan event is exactly the audience that wants it; muting is
 * the exception, so it is the thing that has to be stored.
 */
const KEY = 'hs-battleships:muted';

export function readMuted() {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false; // Private mode, or storage disabled. Loud is the default.
  }
}

export function writeMuted(muted) {
  try {
    if (muted) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    /* nothing to do -- the choice just will not survive the reload */
  }
}
