import { readFileSync } from 'node:fs';
import { check, eq } from './harness';
import { MemoryFolder, TYPES_PATH, listFiles, loadProjectFolder, writeProjectFolder, writeTypeFiles } from '@root/src/engine/projectFolder.ts';
import { spawnSync } from 'node:child_process';
import { nodeFolder } from './nodeFolder';
import { ScriptAsset, ScriptLibrary } from '@root/src/engine/scripting.ts';
import { buildDemoProject } from '@root/src/demoProject.ts';

// The demo project the editor boots with, and the copy of it saved as the project folder examples/Demo/
// (npm run generate:demo).

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

// ---- the saved folder is what the builders make now
{
  const fresh = new MemoryFolder();
  await writeProjectFolder(fresh, built);
  await writeTypeFiles(fresh, ''); // the tsconfig.json; the declarations are checked below
  const saved = nodeFolder(`${root}/examples/Demo`);
  const files = await listFiles(fresh);
  eq('examples/Demo has the same files (else run `npm run generate:demo` in the repo root)', await listFiles(saved), files);
  const stale: string[] = [];
  for (const f of files) {
    const a = await fresh.read(f);
    const b = await saved.read(f).catch(() => new Uint8Array());
    if (Buffer.compare(a, b) !== 0) stale.push(f);
  }
  eq('examples/Demo is current (else run `npm run generate:demo` in the repo root)', stale, []);

  // ...and opens like any project: scripts compile and every scene loads with all its meshes and scripts.
  const { project, resources, warnings: folderWarnings } = await loadProjectFolder(saved);
  eq('the saved demo opens without warnings', folderWarnings, []);
  const scripts = new ScriptLibrary();
  let errors = 0;
  for (const { name, source } of project.scripts) if (!scripts.add(new ScriptAsset(name, source)).compile()) errors++;
  eq('saved demo scripts compile', errors, 0);
  const loadWarnings: string[] = [];
  for (const entry of project.scenes) {
    const scene = await resources.instantiate(entry, scripts, loadWarnings);
    check(`saved demo scene ${entry.name} has objects`, scene.rootObjects.length > 0);
  }
  eq('saved demo scenes load without warnings', loadWarnings, []);
  eq('the build order survives', project.buildScenes().map((s) => s.name), ['Arcade', 'Neon Run', 'Topple', 'Starfall', 'Gem Rush']);
}

// ---- the script types: current, and the demo's scripts type-check against them (what VS Code shows)
{
  const node = process.execPath;
  const types = spawnSync(node, [`${root}/scripts/messier-types.mjs`], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
  eq('messier.d.ts builds', types.status, 0);
  const saved = readFileSync(`${root}/examples/Demo/${TYPES_PATH}`, 'utf8');
  check('examples/Demo has the current script types (else run `npm run generate:demo`)', types.stdout === saved);
  check('they declare the messier module', saved.includes('declare module "messier" {'));
  const tsc = spawnSync(node, [`${root}/node_modules/typescript/bin/tsc`, '-p', `${root}/examples/Demo`], { cwd: root, encoding: 'utf8' });
  eq('the demo scripts type-check against them', tsc.stdout.trim(), '');
}
