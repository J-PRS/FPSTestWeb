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
    port: 5300,
    host: '0.0.0.0',
    allowedHosts: ['.trycloudflare.com'],
    cors: true,
    hmr: {
      // Conditionally use WSS/443 only when accessing through cloudflared tunnel
      protocol: process.env.VITE_HMR_URL ? "wss" : "ws",
      host: process.env.VITE_HMR_URL, // undefined = auto-detect from page URL (works for LAN access)
      clientPort: process.env.VITE_HMR_URL ? 443 : 5300,
      overlay: true, // Show error overlay
    },
    watch: {
      usePolling: true, // Enable polling for reliable HMR in WSL2/Docker
    },
    // No /server proxy: the client connects to ws://host:8000/ws directly,
    // and the stale proxy was swallowing /server.json (prefix match) and
    // trying to WS-proxy it to :8080 — ECONNREFUSED spam.
  },
});
