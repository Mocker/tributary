import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built to ui/dist and served by the Tributary Worker as static assets
// (see [assets] in the repo-root wrangler.jsonc). Relative base so the app
// works from any worker path; the API is same-origin (/v1/...).
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
  },
});
