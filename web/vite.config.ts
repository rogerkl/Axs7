import { defineConfig } from 'vitest/config';

export default defineConfig({
  // relative, so the build works from any path
  base: './',
  server: {
    // all IPv4 interfaces: from WSL, Windows reaches it as http://localhost:5173 (use localhost, Web MIDI needs a
    // secure origin)
    host: '0.0.0.0',
    port: 5173,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
  },
  build: {
    target: 'es2022',
  },
  worker: {
    format: 'es',
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
