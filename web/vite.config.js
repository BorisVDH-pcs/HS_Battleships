import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages serves this repo at https://<user>.github.io/HS_Battleships/, so
// assets need that prefix in production. Locally the base stays '/'.
// Override with BASE_PATH if the site ever moves to its own domain.
const base = process.env.BASE_PATH ?? (process.env.NODE_ENV === 'production' ? '/HS_Battleships/' : '/');

// Port 5174 so this can run alongside the HighSocietyScape dev server on 5173.
export default defineConfig({
  base,
  plugins: [react()],
  server: { port: 5174, strictPort: true },
});
