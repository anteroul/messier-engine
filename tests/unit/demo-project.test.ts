import { existsSync, readFileSync, rmSync } from 'node:fs';
import { check, eq } from './harness';
import { TYPES_PATH, listFiles, loadProjectFolder, writeProjectFolder, writeTypeFiles } from '@root/src/engine/projectFolder.ts';
import { spawnSync } from 'node:child_process';
import { nodeFolder } from './nodeFolder';
import { ScriptAsset, ScriptLibrary } from '@root/src/engine/scripting.ts';
import { buildDemoProject } from '@root/src/demoProject.ts';

// The demo project the editor boots with, and the copy of it npm run generate:demo writes to examples/Demo/ (a git
// repository of its own, ignored by the engine's).

const root = process.env.PROJECT_ROOT!;

// Node can't decode images; the loaders only need a texture to exist (as in scripts/generate-demo-project.mjs).
Object.assign(globalThis, { createImageBitmap: async () => ({ width: 1, height: 1, close() {} }) });

const readModelFile = async (uri: string) => {
  const bytes = readFileSync(`${root}/public/models/${decodeURIComponent(uri)}`);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

const warnings: string[] = [];
const built = await buildDemoProject(readModelFile, warnings);
eq('demo project builds without warnings', warnings.join('; '), '');
eq('demo project scenes', built.scenes.map((s) => s.name).join(','), 'Main,Arcade,Neon Run,Topple,Starfall,Gem Rush');
eq('demo project starts in Main', built.getScene(built.startScene)?.name, 'Main');
eq('demo build is the arcade', built.buildScenes().map((s) => s.name).join(','), 'Arcade,Neon Run,Topple,Starfall,Gem Rush');
eq('demo project assets', built.referencedAssets().map((a) => `${a.id}:${a.files.map((f) => f.name).join('+')}`).join(','), 'lantern:lantern.glb,icosahedron:icosahedron.obj+icosahedron.mtl');

// ---- the demo as a project folder: it opens like any project, and its scripts type-check against the script types
// (what VS Code shows). A fresh copy is written under tests/.out, as examples/ isn't part of the engine repository.
const node = process.execPath;
const types = spawnSync(node, [`${root}/scripts/messier-types.mjs`], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
eq('messier.d.ts builds', types.status, 0);
check('it declares the messier module', types.stdout.includes('declare module "messier" {'));
const freshDir = `${root}/tests/.out/demo-folder`;
rmSync(freshDir, { recursive: true, force: true });
const fresh = nodeFolder(freshDir);
await writeProjectFolder(fresh, built);
await writeTypeFiles(fresh, types.stdout);
{
  const { project, resources, warnings: folderWarnings } = await loadProjectFolder(fresh);
  eq('the demo folder opens without warnings', folderWarnings, []);
  const scripts = new ScriptLibrary();
  let errors = 0;
  for (const { name, source } of project.scripts) if (!scripts.add(new ScriptAsset(name, source)).compile()) errors++;
  eq('demo folder scripts compile', errors, 0);
  const loadWarnings: string[] = [];
  for (const entry of project.scenes) {
    const scene = await resources.instantiate(entry, scripts, loadWarnings);
    check(`demo folder scene ${entry.name} has objects`, scene.rootObjects.length > 0);
  }
  eq('demo folder scenes load without warnings', loadWarnings, []);
  eq('the build order survives', project.buildScenes().map((s) => s.name), ['Arcade', 'Neon Run', 'Topple', 'Starfall', 'Gem Rush']);
  const tsc = spawnSync(node, [`${root}/node_modules/typescript/bin/tsc`, '-p', freshDir], { cwd: root, encoding: 'utf8' });
  eq('the demo scripts type-check against the script types', tsc.stdout.trim(), '');
}

// ---- examples/Demo (its own git repository, when it's there) is what the builders make now
if (!existsSync(`${root}/examples/Demo`)) {
  console.log('SKIP examples/Demo is not there (run `npm run generate:demo` to write it)');
} else {
  const saved = nodeFolder(`${root}/examples/Demo`);
  const files = await listFiles(fresh);
  // The repository's own files aren't part of the project.
  const projectFiles = (await listFiles(saved)).filter((f) => f !== 'README.md' && f !== 'LICENSE');
  eq('examples/Demo has the same files (else run `npm run generate:demo` in the repo root)', projectFiles, files);
  const stale: string[] = [];
  for (const f of [...files, TYPES_PATH]) {
    const a = await fresh.read(f);
    const b = await saved.read(f).catch(() => new Uint8Array());
    if (Buffer.compare(a, b) !== 0) stale.push(f);
  }
  eq('examples/Demo is current (else run `npm run generate:demo` in the repo root)', stale, []);
}
