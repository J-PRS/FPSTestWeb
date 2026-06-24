import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    include: ['colyseus.js'],
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 600,
    // Disable rolldown for better CommonJS compatibility
    rollupOptions: {
      output: {
        codeSplitting: false,
        entryFileNames: 'game.js',
        chunkFileNames: 'game.js',
        assetFileNames: 'game.[ext]',
      },
    },
  },
  server: {
    port: 5174,
    host: '0.0.0.0',
    allowedHosts: ['.trycloudflare.com'],
    cors: true,
    hmr: {
      // Conditionally use WSS/443 only when accessing through cloudflared tunnel
      protocol: process.env.VITE_HMR_URL ? "wss" : "ws",
      host: process.env.VITE_HMR_URL ?? "localhost",
      clientPort: process.env.VITE_HMR_URL ? 443 : 5174,
      overlay: true, // Show error overlay
    },
    watch: {
      usePolling: true, // Enable polling for reliable HMR in WSL2/Docker
    },
    proxy: {
      '/server': {
        target: 'ws://localhost:8080',
        ws: true,
        changeOrigin: true,
        timeout: 30000, // 30 second timeout
        proxyTimeout: 30000,
        configure: (proxy, _options) => {
          proxy.on('error', (err, _req, _res) => {
            console.log('[Vite Proxy] WebSocket error:', err.message);
          });
          proxy.on('proxyReq', (proxyReq, req, _res) => {
            console.log('[Vite Proxy] Proxying WebSocket request:', req.url);
          });
          proxy.on('proxyReqWs', (proxyReq, req, _socket, _options, _head) => {
            console.log('[Vite Proxy] Proxying WebSocket upgrade:', req.url);
          });
        },
      },
    },
  },
});
