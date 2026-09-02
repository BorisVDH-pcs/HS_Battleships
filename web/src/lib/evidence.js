// Evidence uploads: a screenshot proving a tile's task was done.
//
// Two steps, in this order: the file goes to the private `evidence` bucket,
// then add_evidence() registers the row. Storage first because the RPC checks
// that the path belongs to the claim — registering a row for a file that is not
// there yet would be a lie the database cannot catch. The cost is that a failed
// registration leaves an orphaned object; it is unreachable (nothing points at
// it) and an organiser can sweep the bucket after the event.
//
// See supabase/migrations/0021_evidence.sql.

import { supabase } from './supabase.js';
import { uploadToImgbb } from './imgbb.js';

export const BUCKET = 'evidence';

// A phone screenshot is 3-8 MB. Two teams x 100 tiles x several pieces each at
// that size would run past Supabase's 1 GB free tier before the event finished,
// so everything is re-encoded before it leaves the browser. 1600px keeps an
// OSRS interface legible — the point is reading a drop, not pixel-peeping.
const MAX_EDGE = 1600;
const QUALITY = 0.82;

/** Re-encode to WebP at no more than MAX_EDGE on the long side. */
export async function downscale(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, 'image/webp', QUALITY)
  );
  // Safari only got canvas WebP in 14; fall back rather than fail the upload.
  if (blob) return blob;
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
}

/**
 * Upload one file as evidence for a claim.
 *
 * The path is ids only — `{game}/{team}/{claim}/{uuid}` — never the tile name
 * or its icon slug. A filename is visible in the network log, and the tile's
 * identity is secret #2 (see architecture.md). add_evidence() re-derives this
 * same prefix server-side and rejects anything that does not match, so a
 * tampered path buys nothing.
 */
export async function uploadEvidence({ gameId, teamId, claimId, file }) {
  if (!file.type.startsWith('image/')) {
    throw new Error(`${file.name || 'That file'} is not an image.`);
  }

  const blob = await downscale(file);
  if (!blob) throw new Error('Could not read that image.');

  const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
  const path = `${gameId}/${teamId}/${claimId}/${crypto.randomUUID()}.${ext}`;

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, { contentType: blob.type, upsert: false });
  if (upErr) throw new Error(upErr.message);

  // Best-effort: a public mirror for the Discord message to embed. Never
  // blocks the submission — see lib/imgbb.js.
  const publicUrl = await uploadToImgbb(blob);

  const { data, error } = await supabase.rpc('add_evidence', {
    p_claim_id: claimId,
    p_storage_path: path,
    p_public_url: publicUrl,
  });
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Signed URLs for display. The bucket is private, so there is no public URL to
 * build; these expire, which is the point — a link pasted into the wrong
 * Discord channel stops working rather than leaking a tile for the rest of the
 * event.
 */
export async function signedUrls(paths, expiresIn = 3600) {
  if (!paths.length) return {};
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrls(paths, expiresIn);
  if (error) throw new Error(error.message);

  const out = {};
  for (const row of data ?? []) {
    if (row.signedUrl) out[row.path] = row.signedUrl;
  }
  return out;
}
