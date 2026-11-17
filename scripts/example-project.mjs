// Shared by the scripts that write the example project folders (generate-demo-project.mjs → examples/Demo/,
// generate-material-lab.mjs → examples/MaterialLab/): runs engine-only TypeScript under Node and writes a Project
// the way Export to Folder does, script types for code editors included.
import * as esbuild from 'esbuild'; // comes with Vite
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMessierTypes } from './messier-types.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The engine barrel pulls in the renderer, whose WGSL is imported with Vite's `?raw`.
const rawPlugin = {
  name: 'raw',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\?raw$/, '')), namespace: 'raw' }));
    build.onLoad({ filter: /.*/, namespace: 'raw' }, (args) => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }));
  },
};

/** Bundles `source` (TypeScript, resolved from the repo root) and imports it. */
export async function importTS(source) {
  const bundle = await esbuild.build({
    stdin: { contents: source, resolveDir: root, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    write: false,
    plugins: [rawPlugin],
    logLevel: 'warning',
  });
  // Node can't decode images. The loaders only need a texture to exist to give it a ref the scene can save.
  globalThis.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
}

/** Reads sample model files (and their companions) from public/models/, for a builder's ResourceResolver. */
export async function readModelFile(uri) {
  const bytes = readFileSync(resolve(root, 'public/models', decodeURIComponent(uri)));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/**
 * Writes `project` to `outDir` (relative to the repo root) from scratch, so files of renamed or removed scenes don't
 * linger. Each example folder is a git repository of its own, not tracked by the engine's: its .git and the
 * repository's own files are kept.
 */
export async function writeExampleFolder(outDir, project) {
  const { writeProjectFolder, writeTypeFiles } = await importTS(`export { writeProjectFolder, writeTypeFiles } from './src/engine/projectFolder.ts';`);
  const dir = resolve(root, outDir);
  const KEEP = new Set(['.git', '.gitignore', 'README.md', 'LICENSE']);
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) if (!KEEP.has(name)) rmSync(join(dir, name), { recursive: true, force: true });
  const at = (p) => join(dir, p);
  const folder = {
    async list(path) {
      try {
        return readdirSync(at(path), { withFileTypes: true }).map((e) => ({ name: e.name, kind: e.isDirectory() ? 'directory' : 'file' }));
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
  console.log(`Wrote ${dir}/ (${written.scenes.length} scenes, ${written.scripts.length} scripts, ${written.assets.length} assets)`);
}
