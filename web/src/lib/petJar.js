// Pet jar submissions: proof of a pet or jar drop, earning one tile preview.
//
// A sibling of evidence.js, not a reuse of it — a submission here isn't proof
// against a claimed tile, it's the resource that earns the preview currency
// (see supabase/migrations/0039_pet_jar.sql). Same two-step order as evidence:
// storage first, then submit_pet_jar() registers the row, because the RPC
// checks the path belongs to the team and a row for a file that isn't there
// yet would be a lie the database cannot catch.

import { supabase } from './supabase.js';
import { downscale } from './evidence.js';

export const BUCKET = 'pet-jar';

/** Upload one pet/jar screenshot and credit the team's pet jar counter. */
export async function uploadPetJar({ gameId, teamId, file }) {
  if (!file.type.startsWith('image/')) {
    throw new Error(`${file.name || 'That file'} is not an image.`);
  }

  const blob = await downscale(file);
  if (!blob) throw new Error('Could not read that image.');

  const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
  const path = `${gameId}/${teamId}/${crypto.randomUUID()}.${ext}`;

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, { contentType: blob.type, upsert: false });
  if (upErr) throw new Error(upErr.message);

  const { data, error } = await supabase.rpc('submit_pet_jar', {
    p_game_id: gameId,
    p_storage_path: path,
  });
  if (error) throw new Error(error.message);
  return data;
}
