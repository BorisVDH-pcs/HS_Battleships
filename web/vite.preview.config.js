import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// A second dev server for the evidence-review harness, on its own port so it
// can run beside the real app (5174) and HighSocietyScape (5173).
//
// The only thing this config does beyond the main one is swap two modules:
// EvidenceReview's `../lib/supabase.js` and `../lib/evidence.js` resolve to
// stubs, so the component runs with canned rows instead of a live project.
// Everything else it imports — ConfirmDialog, board.js, millions.js, the
// stylesheet — is the real file.
//
// A regex `find` rather than a plain alias because the import is written
// relative to the component, so there is no bare specifier to match on.
//
// The `^.*` matters: Vite substitutes the MATCHED SUBSTRING, so a pattern of
// just `/lib/supabase.js$` would leave the leading `..` behind and resolve to
// `..C:/…`. The pattern has to span the whole specifier.
const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: '.',
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^.*\/lib\/supabase\.js$/, replacement: here('./src/preview/stub-supabase.js') },
      { find: /^.*\/lib\/evidence\.js$/, replacement: here('./src/preview/stub-evidence.js') },
    ],
  },
  // No `open`: the page is driven from the Browser pane, and a config that
  // launches the desktop browser on every restart is a nuisance there.
  server: { port: 5176, strictPort: true },
});
