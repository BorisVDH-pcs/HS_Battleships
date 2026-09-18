/**
 * Stand-in for lib/evidence.js in the harness. The real one mints signed URLs
 * against a private Supabase bucket; here the thumbnails are inline SVG, so the
 * layout is real and nothing leaves the machine.
 */
import { DEMO_URLS } from './stub-supabase.js';

export const BUCKET = 'evidence';

export async function signedUrls(paths) {
  const out = {};
  for (const p of paths) if (DEMO_URLS[p]) out[p] = DEMO_URLS[p];
  return out;
}

// The harness only renders EvidenceReview, which needs signedUrls and nothing
// else. These exist because this server also serves the app's own index.html
// at `/`, and a visit there pulls in EvidenceUploader: a missing export is a
// hard module error that breaks the page before anything renders. Stubbed to
// refuse rather than to pretend — uploading has no meaning without a database.
export async function downscale() {
  throw new Error('Uploads are not available in the evidence harness.');
}

export async function uploadEvidence() {
  throw new Error('Uploads are not available in the evidence harness.');
}
