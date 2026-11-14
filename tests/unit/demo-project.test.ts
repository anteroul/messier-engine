import { readFileSync } from 'node:fs';
import { check, eq } from './harness';
import { Project, ProjectResources } from '@root/src/engine/project.ts';
import { ScriptAsset, ScriptLibrary } from '@root/src/engine/scripting.ts';
import { buildDemoProject } from '@root/src/demoProject.ts';

// The demo project the editor boots with, and the copy of it saved in examples/ (npm run generate:demo).

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

// ---- the saved copy is what the builders make now
{
  const saved = new Uint8Array(readFileSync(`${root}/examples/Demo.messier`));
  check('examples/Demo.messier is current (else run `npm run generate:demo` in the repo root)', Buffer.compare(saved, built.encode()) === 0);

  // ...and opens like any project: scripts compile and every scene loads with all its meshes and scripts.
  const project = Project.decode(saved);
  const scripts = new ScriptLibrary();
  let errors = 0;
  for (const { name, source } of project.scripts) if (!scripts.add(new ScriptAsset(name, source)).compile()) errors++;
  eq('saved demo scripts compile', errors, 0);
  const resources = new ProjectResources(project);
  const loadWarnings: string[] = [];
  for (const entry of project.scenes) {
    const scene = await resources.instantiate(entry, scripts, loadWarnings);
    check(`saved demo scene ${entry.name} has objects`, scene.rootObjects.length > 0);
  }
  eq('saved demo scenes load without warnings', loadWarnings.join('; '), '');
}
