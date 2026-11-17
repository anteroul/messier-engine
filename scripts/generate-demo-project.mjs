// Writes examples/Demo/: the demo project the editor starts with, as a project folder (Export to Folder writes the
// same, script types for code editors included).
// Run via `npm run generate:demo` after changing a demo scene builder or a sample model (tests/unit checks it's current).
import * as esbuild from 'esbuild'; // comes with Vite
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMessierTypes } from './messier-types.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'examples/Demo');

// The engine barrel pulls in the renderer, whose WGSL is imported with Vite's `?raw`.
const rawPlugin = {
  name: 'raw',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\?raw$/, '')), namespace: 'raw' }));
    build.onLoad({ filter: /.*/, namespace: 'raw' }, (args) => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }));
  },
};

const bundle = await esbuild.build({
  stdin: {
    contents: `export { buildDemoProject } from './src/demoProject.ts';\nexport { writeProjectFolder, writeTypeFiles } from './src/engine/projectFolder.ts';`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  write: false,
  plugins: [rawPlugin],
  logLevel: 'warning',
});
const { buildDemoProject, writeProjectFolder, writeTypeFiles } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

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

// Fresh each time, so files of renamed or removed scenes don't linger. The folder is a git repository of its own
// (github.com/anteroul/messier-arcade, not tracked by the engine's): keep its .git and the repository's own files.
const KEEP = new Set(['.git', '.gitignore', 'README.md', 'LICENSE']);
mkdirSync(outDir, { recursive: true });
for (const name of readdirSync(outDir)) if (!KEEP.has(name)) rmSync(join(outDir, name), { recursive: true, force: true });
const at = (p) => join(outDir, p);
const folder = {
  async list(dir) {
    try {
      return readdirSync(at(dir), { withFileTypes: true }).map((e) => ({ name: e.name, kind: e.isDirectory() ? 'directory' : 'file' }));
    } catch {
      return [];
    }
  },
  async read(path) {
    return new Uint8Array(readFileSync(at(path)));
  },
  async write(path, data) {
    mkdirSync(dirname(at(path)), { recursive: true });
    writeFileSync(at(path), data);
  },
  async remove(path) {
    rmSync(at(path), { recursive: true, force: true });
  },
  async stat(path) {
    try {
      const s = statSync(at(path));
      return { size: s.size, modified: s.mtimeMs };
    } catch {
      return null;
    }
  },
};
const written = await writeProjectFolder(folder, project);
// What the editor adds to every project folder, so VS Code can check the scripts.
await writeTypeFiles(folder, buildMessierTypes(root));
console.log(`Wrote ${outDir}/ (${written.scenes.length} scenes, ${written.scripts.length} scripts, ${written.assets.length} assets)`);
