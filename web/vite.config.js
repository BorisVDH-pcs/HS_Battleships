import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Port 5174 so this can run alongside the HighSocietyScape dev server on 5173.
export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: true },
});
