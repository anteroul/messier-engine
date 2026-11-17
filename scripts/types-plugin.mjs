// Serves (dev) and emits (build) messier.d.ts next to the editor, which writes it into project folders. The dev
// server builds it on request, cached until an engine file changes.
import { fileURLToPath } from 'node:url';
import { TYPES_FILE, buildMessierTypes } from './messier-types.mjs';

/** @returns {import('vite').Plugin} */
export function typesPlugin() {
  const engine = fileURLToPath(new URL('../src/engine', import.meta.url));
  /** @type {string | null} */
  let cached = null;
  return {
    name: 'messier-types',
    configureServer(server) {
      server.watcher.on('all', (_event, file) => {
        if (file.startsWith(engine)) cached = null;
      });
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== `${server.config.base}${TYPES_FILE}`) return next();
        try {
          cached ??= buildMessierTypes();
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(cached);
        } catch (err) {
          next(err);
        }
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: TYPES_FILE, source: buildMessierTypes() });
    },
  };
}
