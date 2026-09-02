// A public mirror of one evidence/pet-jar screenshot, purely so a Discord
// webhook message can embed it inline. imgbb rather than a signed Supabase
// URL because the relay is pure Postgres (pg_net) with no way to mint a
// signed URL synchronously — imgbb takes the bytes the browser already has.
//
// Best-effort by design, matching the relay's own "a shot must not fail
// because a chat service is having a bad day": if the key is unset or the
// upload fails, evidence/pet-jar submission proceeds exactly as it did before
// this existed, just without an image riding along in Discord.

const KEY = import.meta.env.VITE_IMGBB_API_KEY;

/** Upload a blob to imgbb; returns its public URL, or null if unavailable. */
export async function uploadToImgbb(blob) {
  if (!KEY || !blob) return null;

  try {
    const form = new FormData();
    form.append('image', blob);

    const res = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(KEY)}`, {
      method: 'POST',
      body: form,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.data?.url) {
      console.warn('imgbb upload failed', body?.error?.message ?? res.status);
      return null;
    }
    return body.data.url;
  } catch (err) {
    console.warn('imgbb upload failed', err.message);
    return null;
  }
}
