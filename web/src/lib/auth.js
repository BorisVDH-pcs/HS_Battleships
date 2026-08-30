// Username-only sign-in.
//
// Supabase Auth has no native username identity — it keys on email. So each
// player's username is mapped to a synthetic internal address that no mail is
// ever sent to. Players never see or type it.
//
// Consequence, accepted deliberately: there is no self-service password reset,
// because there is no real mailbox to send a link to. An admin resets a
// password from the Supabase dashboard (Authentication > Users) instead.
//
// The display name keeps the username exactly as typed (RuneScape names contain
// spaces and capitals); only the derived address is normalised.

// `.invalid` is reserved by IANA and can never resolve, so even if email
// confirmation were switched back on, no mail could leak to a domain we do not
// own. Supabase rejects `.local` outright as a malformed address; `.invalid`
// passes its format check.
const DOMAIN = 'players.hs-battleships.invalid';

/** Usernames are compared case-insensitively and space-insensitively. */
export function usernameToEmail(username) {
  const slug = username
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9._-]/g, '');
  return `${slug}@${DOMAIN}`;
}

/**
 * Returns an error string, or null when the username is usable.
 * Kept strict enough that the derived address is always a valid one.
 */
export function validateUsername(username) {
  const trimmed = username.trim();
  if (trimmed.length < 2) return 'Username must be at least 2 characters.';
  if (trimmed.length > 32) return 'Username must be 32 characters or fewer.';
  if (!/^[A-Za-z0-9 ._-]+$/.test(trimmed)) {
    return 'Use only letters, numbers, spaces, dots, underscores or hyphens.';
  }
  const slug = usernameToEmail(trimmed).split('@')[0];
  if (slug.length < 2) return 'That username has too few usable characters.';
  return null;
}

/** Turns Supabase's auth errors into something a player can act on. */
export function friendlyAuthError(message) {
  if (/invalid login credentials/i.test(message)) return 'Wrong username or password.';
  if (/user already registered/i.test(message)) return 'That username is taken.';
  if (/password should be at least/i.test(message)) {
    return 'Password must be at least 8 characters.';
  }
  if (/email address .* is invalid/i.test(message)) {
    return 'That username contains characters we cannot use. Try letters and numbers only.';
  }
  if (/signups not allowed|signup is disabled/i.test(message)) {
    return 'Sign-ups are currently closed — ask an admin to create your account.';
  }
  if (/confirm/i.test(message) && /email/i.test(message)) {
    return 'This account needs email confirmation turned off in Supabase — tell an admin.';
  }
  return message;
}
