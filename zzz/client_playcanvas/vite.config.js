import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5200,
    host: true
  },
  publicDir: 'assets',
  resolve: {
    extensions: ['.ts', '.js']
  }
});
