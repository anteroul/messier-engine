import { defineConfig } from 'vite';
import pkg from './package.json';
import { mangleOptions } from './scripts/mangle-props.mjs';
import { playerPlugin } from './scripts/player-plugin.mjs';

export default defineConfig(({ command }) => ({
  // The editor shows it (☰ menu, help).
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: { port: 5173 },
  preview: { port: 4173 },
  build: { target: 'es2022', sourcemap: true },
  // Release builds rename `_`-prefixed (internal) properties; see scripts/mangle-props.mjs.
  esbuild: command === 'build' ? mangleOptions(new URL('./src', import.meta.url)) : undefined,
  // Serves / emits messier-player.js, the game runtime File → Build puts in exported games.
  plugins: [playerPlugin()],
}));
