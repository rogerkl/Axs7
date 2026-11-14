import { defineConfig } from 'vitest/config';

// SM-87's browser emulator at /sm-87/emu/ on this origin, as on rogerkl.github.io, for OPEN IN EMULATOR (it hands the
// emulator its samples within one origin: sm87/sm87emu.js): a server of SM-87's emulator build (its app/build/emu, as
// python3 -m http.server -d app/build/emu 8087 serves it), SM87_EMU if not that one
const sm87Emu = {
  '/sm-87/emu': {
    target: process.env.SM87_EMU ?? 'http://localhost:8087',
    rewrite: (path: string) => path.replace(/^\/sm-87\/emu/, ''),
  },
};

export default defineConfig({
  // relative, so the build works from any path
  base: './',
  server: {
    // all IPv4 interfaces: from WSL, Windows reaches it as http://localhost:5173 (use localhost, Web MIDI needs a
    // secure origin)
    host: '0.0.0.0',
    port: 5173,
    proxy: sm87Emu,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    proxy: sm87Emu,
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
