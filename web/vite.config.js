import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages serves this repo at https://<user>.github.io/HS_Battleships/, so
// assets need that prefix in production. Locally the base stays '/'.
// Override with BASE_PATH if the site ever moves to its own domain.
const base = process.env.BASE_PATH ?? (process.env.NODE_ENV === 'production' ? '/HS_Battleships/' : '/');

// Port 5174 so this can run alongside the HighSocietyScape dev server on 5173.
//
// `strictPort` only while that 5174 is our own choice: asked for a port and
// silently given a different one is how you end up reading a stale tab and
// wondering why an edit did nothing. But a harness that assigns a port through
// PORT has already decided, and failing on it would just refuse to start a
// second copy of this app — which is the ordinary case when one is already
// running from another session.
const port = Number(process.env.PORT) || 5174;

export default defineConfig({
  base,
  plugins: [react()],
  server: { port, strictPort: !process.env.PORT },
});
