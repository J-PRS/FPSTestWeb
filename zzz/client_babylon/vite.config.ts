import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],
  build: {
    rollupOptions: {
      output: {
        codeSplitting: false, // Disable code splitting for single chunk
      }
    },
    chunkSizeWarningLimit: 1000, // Increase warning limit
  }
})
