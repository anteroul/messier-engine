// Bundles render.test.ts together with the engine sources (WGSL `?raw` imports
// become text) and runs it under Node with Dawn providing WebGPU.
import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const out = resolve(here, '../.out');
mkdirSync(out, { recursive: true });

const rawPlugin = {
  name: 'raw',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
      namespace: 'raw',
    }));
    build.onLoad({ filter: /.*/, namespace: 'raw' }, (args) => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }));
  },
};

const bundle = resolve(out, 'render.bundle.mjs');
await esbuild.build({
  entryPoints: [resolve(here, 'render.test.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: bundle,
  external: ['webgpu'],
  alias: { '@root': root },
  plugins: [rawPlugin],
  logLevel: 'warning',
});

const res = spawnSync(process.execPath, [bundle], {
  stdio: 'inherit',
  env: { ...process.env, PROJECT_ROOT: root, OUT_DIR: out },
});
process.exit(res.status ?? 1);
