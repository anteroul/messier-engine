// Runs the GPU-free unit tests: bundles each tests/unit/*.test.ts with the engine sources and runs it under Node.
// Run via `npm run test:unit`.
import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const out = resolve(here, '../.out/unit');
mkdirSync(out, { recursive: true });

// The engine barrel pulls in the renderer, whose WGSL is imported with Vite's `?raw`.
const rawPlugin = {
  name: 'raw',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\?raw$/, '')), namespace: 'raw' }));
    build.onLoad({ filter: /.*/, namespace: 'raw' }, (args) => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }));
  },
};

const only = process.argv[2];
const files = readdirSync(here).filter((f) => f.endsWith('.test.ts') && (!only || f.includes(only))).sort();
let failed = 0;
for (const file of files) {
  const bundle = resolve(out, file.replace(/\.ts$/, '.mjs'));
  await esbuild.build({
    entryPoints: [resolve(here, file)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: bundle,
    alias: { '@root': root },
    plugins: [rawPlugin],
    logLevel: 'warning',
  });
  console.log(`\n# ${file}`);
  const res = spawnSync(process.execPath, [bundle], { stdio: 'inherit' });
  if (res.status !== 0) failed++;
}
console.log(failed ? `\n${failed} unit test file(s) FAILED` : `\nALL ${files.length} unit test files PASSED`);
process.exit(failed ? 1 : 0);
