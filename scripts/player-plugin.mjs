// Bundles the game runtime (src/player.ts) into one classic script, `messier-player.js`, that File → Build inlines into
// the exported page. The dev server builds it on request (cached until a source file changes); `vite build` emits it
// next to the editor. It's always minified and property-mangled like a release build: it ships inside games.
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { mangleOptions } from './mangle-props.mjs';

export const PLAYER_FILE = 'messier-player.js';

/** @returns {import('vite').Plugin} */
export function playerPlugin() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const src = fileURLToPath(new URL('../src', import.meta.url));
  /** @type {Promise<string> | null} */
  let cached = null;
  const bundle = () =>
    (cached ??= bundlePlayer(root, src).catch((err) => {
      cached = null;
      throw err;
    }));

  return {
    name: 'messier-player',
    configureServer(server) {
      server.watcher.on('all', (_event, file) => {
        if (file.startsWith(src)) cached = null;
      });
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.split('?')[0] !== `${server.config.base}${PLAYER_FILE}`) return next();
        try {
          const code = await bundle();
          res.setHeader('Content-Type', 'text/javascript');
          res.setHeader('Cache-Control', 'no-store');
          res.end(code);
        } catch (err) {
          next(err);
        }
      });
    },
    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: PLAYER_FILE, source: await bundle() });
    },
  };
}

async function bundlePlayer(root, src) {
  const out = await build({
    configFile: false,
    root,
    publicDir: false,
    logLevel: 'warn',
    esbuild: mangleOptions(src),
    build: {
      write: false,
      target: 'es2022',
      minify: 'esbuild',
      sourcemap: false,
      reportCompressedSize: false,
      lib: { entry: `${src}/player.ts`, formats: ['iife'], name: 'MessierPlayer', fileName: () => PLAYER_FILE },
    },
  });
  const outputs = (Array.isArray(out) ? out : [out]).flatMap((o) => ('output' in o ? o.output : []));
  const chunk = outputs.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Player bundle produced no code');
  return chunk.code;
}
