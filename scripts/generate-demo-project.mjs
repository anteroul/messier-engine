// Writes examples/Demo.messier: the demo project the editor starts with, saved like File → Save would.
// Run via `npm run generate:demo` after changing a demo scene builder or a sample model (tests/unit checks it's current).
import * as esbuild from 'esbuild'; // comes with Vite
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = resolve(root, 'examples/Demo.messier');

// The engine barrel pulls in the renderer, whose WGSL is imported with Vite's `?raw`.
const rawPlugin = {
  name: 'raw',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\?raw$/, '')), namespace: 'raw' }));
    build.onLoad({ filter: /.*/, namespace: 'raw' }, (args) => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }));
  },
};

const bundle = await esbuild.build({
  stdin: { contents: `export { buildDemoProject } from './src/demoProject.ts';`, resolveDir: root, loader: 'ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  write: false,
  plugins: [rawPlugin],
  logLevel: 'warning',
});
const { buildDemoProject } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

// Node can't decode images. The loaders only need a texture to exist to give it a ref the scene can save.
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

const warnings = [];
const project = await buildDemoProject(async (uri) => {
  const bytes = readFileSync(resolve(root, 'public/models', decodeURIComponent(uri)));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}, warnings);
if (warnings.length) {
  console.error(warnings.join('\n'));
  process.exit(1);
}

const bytes = project.encode();
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, bytes);
console.log(`Wrote ${outFile} (${bytes.byteLength} bytes, ${project.scenes.length} scenes, ${project.scripts.length} scripts, ${project.assets.length} assets)`);
