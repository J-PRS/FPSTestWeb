import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5174,
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      '/server': {
        target: 'ws://localhost:8080',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      output: {
        codeSplitting: false,
        entryFileNames: 'game.js',
        chunkFileNames: 'game.js',
        assetFileNames: 'game.[ext]',
      },
    },
  },
});
