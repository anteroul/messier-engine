import { existsSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { check, eq } from './harness';
import { nodeFolder } from './nodeFolder';
import { TYPES_PATH, listFiles, loadProjectFolder, writeProjectFolder, writeTypeFiles } from '@root/src/engine/projectFolder.ts';
import { Script, ScriptAsset, ScriptLibrary } from '@root/src/engine/scripting.ts';
import { TEXTURE_SLOTS } from '@root/src/engine/material.ts';
import type { Scene } from '@root/src/engine/scene.ts';
import { Text2D } from '@root/src/engine/shapes2d.ts';
import { Time } from '@root/src/engine/time.ts';
import { input } from '@root/src/engine/input.ts';
import { buildMaterialLabProject } from '@root/src/materialLab/index.ts';

// The Material Lab example project, and the copy npm run generate:materials writes to examples/MaterialLab/ (a git
// repository of its own, ignored by the engine's).

const root = process.env.PROJECT_ROOT!;

// Node can't decode images; the loaders only need a texture to exist (as in scripts/example-project.mjs).
Object.assign(globalThis, { createImageBitmap: async () => ({ width: 1, height: 1, close() {} }) });

const readModelFile = async (uri: string) => {
  const bytes = readFileSync(`${root}/public/models/${decodeURIComponent(uri)}`);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

const built = await buildMaterialLabProject(readModelFile);
eq('scenes, in build order', built.buildScenes().map((s) => s.name), ['Gallery', 'Orbit']);
eq('starts in the Gallery', built.getScene(built.startScene)?.name, 'Gallery');
eq('one asset: the model', built.referencedAssets().map((a) => `${a.id}:${a.files.map((f) => f.name).join('+')}`), ['material-lab:material-lab.glb']);

// ---- as a project folder: it opens like any project, and its scripts type-check against the script types
const types = spawnSync(process.execPath, [`${root}/scripts/messier-types.mjs`], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
eq('messier.d.ts builds', types.status, 0);
const freshDir = `${root}/tests/.out/material-lab-folder`;
rmSync(freshDir, { recursive: true, force: true });
const fresh = nodeFolder(freshDir);
await writeProjectFolder(fresh, built);
await writeTypeFiles(fresh, types.stdout);
const { project, resources, warnings: folderWarnings } = await loadProjectFolder(fresh);
eq('the folder opens without warnings', folderWarnings, []);
const scripts = new ScriptLibrary();
for (const { name, source } of project.scripts) {
  const asset = scripts.add(new ScriptAsset(name, source));
  check(`${name} compiles`, asset.compile(), JSON.stringify(asset.diagnostics));
}
const tsc = spawnSync(process.execPath, [`${root}/node_modules/typescript/bin/tsc`, '-p', freshDir], { cwd: root, encoding: 'utf8' });
eq('the scripts type-check against the script types', tsc.stdout.trim(), '');

const loadWarnings: string[] = [];
const scenes = new Map<string, Scene>();
for (const entry of project.scenes) scenes.set(entry.name, await resources.instantiate(entry, scripts, loadWarnings));
eq('the scenes load without warnings', loadWarnings, []);

// ---- the build-up: each stage adds one map, and every map resolves to a texture of the model
const gallery = scenes.get('Gallery')!;
const maps = (stage: number) => {
  const m = gallery.findByName(`Stage ${stage}`)!.find('Cube')!.material!;
  return TEXTURE_SLOTS.filter((slot) => m[slot]);
};
eq('stage 1: base color', maps(1), ['baseColorTexture']);
eq('stage 2: + normal', maps(2), ['baseColorTexture', 'normalTexture']);
eq('stage 3: + metal/rough', maps(3), ['baseColorTexture', 'normalTexture', 'metallicRoughnessTexture']);
eq('stage 4: + occlusion', maps(4), ['baseColorTexture', 'normalTexture', 'metallicRoughnessTexture', 'occlusionTexture']);
eq('stage 5: + emissive', maps(5), [...TEXTURE_SLOTS]);
const hull = gallery.findByName('Panel 1-1')!.material!;
eq('the wall has every map', TEXTURE_SLOTS.filter((slot) => hull[slot]), [...TEXTURE_SLOTS]);
check('ORM: one image for metal/rough and occlusion', hull.metallicRoughnessTexture === hull.occlusionTexture);
check('every map comes from the model', [...scenes.values()].every((scene) => {
  let ok = true;
  scene.traverse((o) => {
    for (const slot of TEXTURE_SLOTS) {
      const ref = o.material?.[slot]?.ref;
      if (o.material?.[slot] && !(ref && 'asset' in ref && ref.asset === 'material-lab')) ok = false;
    }
  });
  return ok;
}));

// ---- playing: the light sweeps, the glow pulses, Space strips the maps and puts them back
function frame(scene: Scene, dt = 1 / 60): void {
  const steps = Time.beginFrame(dt);
  for (let i = 0; i < steps; i++) {
    scene.fixedUpdate(Time.fixedDeltaTime);
    Time.fixedStepDone();
  }
  scene.updateBehaviours(Time.deltaTime, Time.time);
  scene.lateUpdate(Time.deltaTime);
  input.endFrame();
  scene.updateMatrices();
  scene.processDestroyed();
}
const run = (scene: Scene, seconds: number) => {
  for (let t = 0; t < seconds; t += 1 / 60) frame(scene);
};
const errors = () => scripts.scripts.flatMap((a) => a.diagnostics.map((d) => `${a.name}:${d.line}: ${d.message}`));
function play(scene: Scene): void {
  Time.reset();
  input.reset();
  scene.setRunning(true);
  run(scene, 0.1);
}

{
  play(gallery);
  const light = gallery.findByName('Sweep Light')!;
  const x0 = light.transform.position[0];
  const stage5 = gallery.findByName('Stage 5')!.find('Cube')!.material!;
  const glow0 = stage5.emissiveStrength;
  run(gallery, 1.2);
  check('Gallery: the light sweeps', Math.abs(light.transform.position[0] - x0) > 1, `${x0} → ${light.transform.position[0]}`);
  check('Gallery: the glow pulses', stage5.emissiveStrength < glow0 - 0.1, `${glow0} → ${stage5.emissiveStrength}`);
  const lab = gallery.query(Script).find((s) => s.typeName === 'Lab') as unknown as { mapsShown: boolean };
  input.keyDown('Space');
  frame(gallery);
  input.keyUp('Space');
  check('Gallery: Space strips the maps', !lab.mapsShown && !stage5.normalTexture && !stage5.emissiveTexture && stage5.baseColorTexture !== null && stage5.emissiveStrength === 0);
  eq('Gallery: the HUD says so', gallery.findByName('Status')!.getComponent(Text2D)!.text, 'Maps: base color only');
  input.keyDown('Space');
  frame(gallery);
  input.keyUp('Space');
  check('Gallery: …and puts them back', lab.mapsShown && !!stage5.normalTexture && !!stage5.emissiveTexture && stage5.emissiveStrength > 0);
  eq('Gallery: no script errors', errors(), []);
  gallery.setRunning(false);
}

{
  const orbit = scenes.get('Orbit')!;
  play(orbit);
  const sun = orbit.findByName('Sun')!;
  const f0 = sun.transform.forward;
  const ring = orbit.findByName('Ring')!;
  const r0 = [...ring.transform.rotation];
  run(orbit, 3);
  const f1 = sun.transform.forward;
  check('Orbit: the sun circles', Math.hypot(f1[0] - f0[0], f1[2] - f0[2]) > 0.3 && Math.abs(f1[1] - f0[1]) < 0.05, `${f0} → ${f1}`);
  check('Orbit: the ring turns', ring.transform.rotation.some((v, i) => Math.abs(v - r0[i]) > 0.05));
  eq('Orbit: no script errors', errors(), []);
  orbit.setRunning(false);
}

// ---- examples/MaterialLab (its own git repository, when it's there) is what the builders make now
if (!existsSync(`${root}/examples/MaterialLab`)) {
  console.log('SKIP examples/MaterialLab is not there (run `npm run generate:materials` to write it)');
} else {
  const saved = nodeFolder(`${root}/examples/MaterialLab`);
  const files = await listFiles(fresh);
  const projectFiles = (await listFiles(saved)).filter((f) => f !== 'README.md' && f !== 'LICENSE');
  eq('examples/MaterialLab has the same files (else run `npm run generate:materials` in the repo root)', projectFiles, files);
  const stale: string[] = [];
  for (const f of [...files, TYPES_PATH]) {
    const a = await fresh.read(f);
    const b = await saved.read(f).catch(() => new Uint8Array());
    if (Buffer.compare(a, b) !== 0) stale.push(f);
  }
  eq('examples/MaterialLab is current (else run `npm run generate:materials` in the repo root)', stale, []);
}
