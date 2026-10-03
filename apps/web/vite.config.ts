import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server binds to loopback and proxies the API without rewriting Host/Origin,
// so the server's Host/Origin allowlist applies unchanged.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5317,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:4317', changeOrigin: false } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
