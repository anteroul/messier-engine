import { defineConfig } from 'vite';
import { mangleOptions } from './scripts/mangle-props.mjs';

export default defineConfig(({ command }) => ({
  server: { port: 5173 },
  preview: { port: 4173 },
  build: { target: 'es2022', sourcemap: true },
  // Release builds rename `_`-prefixed (internal) properties; see scripts/mangle-props.mjs.
  esbuild: command === 'build' ? mangleOptions(new URL('./src', import.meta.url)) : undefined,
}));
