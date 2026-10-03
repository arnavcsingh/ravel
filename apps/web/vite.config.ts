import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.PORT ?? '4317'}`,
        // The Go service rejects foreign origins. Vite is the trusted local
        // development proxy, so forward both Host and Origin as the backend.
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (request) => {
            request.setHeader('Origin', `http://127.0.0.1:${process.env.PORT ?? '4317'}`);
          });
        },
      },
    },
  },
});
