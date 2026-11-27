import { existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { check, eq } from './harness';
import { nodeFolder } from './nodeFolder';
import { TYPES_PATH, listFiles, loadProjectFolder, writeProjectFolder, writeTypeFiles } from '@root/src/engine/projectFolder.ts';
import { Script, ScriptAsset, ScriptLibrary } from '@root/src/engine/scripting.ts';
import { GameObject, type Scene } from '@root/src/engine/scene.ts';
import { Material } from '@root/src/engine/material.ts';
import { createCube } from '@root/src/engine/primitives.ts';
import { Time } from '@root/src/engine/time.ts';
import { input } from '@root/src/engine/input.ts';
import { vec3, type Vec3 } from '@root/src/engine/math.ts';
import { buildTwilightHeistProject } from '@root/src/twilightHeist/index.ts';

// The Twilight Heist example project, and the copy npm run generate:heist writes to examples/TwilightHeist/ (a git
// repository of its own, ignored by the engine's).

const root = process.env.PROJECT_ROOT!;

const built = buildTwilightHeistProject();
eq('scenes, in build order', built.buildScenes().map((s) => s.name), ['Garden']);
eq('no assets: it is all primitives', built.referencedAssets().length, 0);

// ---- as a project folder: it opens like any project, and its scripts type-check against the script types
const types = spawnSync(process.execPath, [`${root}/scripts/messier-types.mjs`], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
eq('messier.d.ts builds', types.status, 0);
const freshDir = `${root}/tests/.out/twilight-heist-folder`;
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
const garden = await resources.instantiate(project.scenes[0], scripts, loadWarnings);
eq('the scene loads without warnings', loadWarnings, []);

// ---- what it shows off
const lights: { name: string; type: string; shadows: boolean }[] = [];
garden.traverse((o) => void (o.light && lights.push({ name: o.name, type: o.light.type, shadows: o.light.castShadows })));
// Four spot lights (a layer each) and one point light (six) fit the twelve point/spot shadow layers at once.
eq('shadow-casting lights: the sun, three tower lamps, the candlelight and the brazier', lights.filter((l) => l.shadows).map((l) => `${l.type} ${l.name}`).sort(), [
  'directional Sun',
  'point Brazier Fire',
  'spot Candlelight',
  'spot North-East Tower Lamp',
  'spot North-West Tower Lamp',
  'spot South-East Tower Lamp',
]);
const blends = new Set<string>();
garden.traverse((o) => void (o.material && o.material.blend !== 'opaque' && blends.add(`${o.material.name}:${o.material.blend}`)));
eq('blended materials: glass and water, flames, halos and fireflies', [...blends].sort(), [
  'Fire Glow:additive', 'Firefly:additive', 'Flame:additive', 'Lamp Halo:additive', 'Ruby Glass:alpha', 'Sapphire Glass:alpha', 'Water:alpha',
]);

// ---- playing
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

interface HeistApi {
  coinsTaken: number;
  alarmLevel: number;
  seen: boolean;
  hasEscaped: boolean;
  restart(): void;
}

Time.reset();
input.reset();
garden.setRunning(true);
run(garden, 0.1);
const heist = garden.query(Script).find((s) => s.typeName === 'Heist') as unknown as HeistApi;
const thief = garden.findByName('Thief')!;
const at = (p: Vec3) => {
  thief.transform.position = [p[0], 0, p[2]];
  frame(garden);
};
const hold = (code: string, seconds: number) => {
  input.keyDown(code);
  run(garden, seconds);
  input.keyUp(code);
  frame(garden);
};

{
  run(garden, 8);
  check('the start is out of every lamp\'s sweep', heist.alarmLevel === 0, `${heist.alarmLevel}`);
  const z0 = thief.transform.position[2];
  hold('KeyW', 0.5);
  check('W sneaks north', thief.transform.position[2] < z0 - 1.5, `${z0} → ${thief.transform.position[2]}`);
  hold('KeyS', 3);
  check('the south wall stops the thief', thief.transform.position[2] <= 20 - 0.34 && thief.transform.position[2] > 19, `${thief.transform.position[2]}`);
  heist.restart();
}

// Freeze the lamps, so where they look is known: each points at its heading, tilted down.
for (const s of garden.query(Script)) if (s.typeName === 'Searchlight') (s as unknown as { sweep: number }).sweep = 0;
frame(garden);
// The south-east lamp's beam lands on open lawn (the others' land by statues, which hide the thief).
const lamp = garden.findByName('South-East Tower Lamp')!;
const from = lamp.transform.worldPosition, dir = lamp.transform.forward;
// Where the beam's axis meets the ground.
const spot = vec3.addScaled(from, dir, -from[1] / dir[1]);

{
  heist.restart();
  at(spot);
  run(garden, 0.3);
  check('a lamp sees the thief in its beam', heist.seen && heist.alarmLevel > 0.1, `seen=${heist.seen} alarm=${heist.alarmLevel} at ${spot.map((v) => v.toFixed(1))}`);

  // A wall between the lamp and the thief: its shadow hides them.
  const screen = new GameObject('Screen');
  screen.mesh = createCube(1);
  screen.material = new Material('Screen');
  const toward = vec3.normalize([from[0] - spot[0], 0, from[2] - spot[2]]);
  screen.transform.position = vec3.add(vec3.addScaled(spot, toward, 1.2), [0, 1.5, 0]);
  screen.transform.scale = [3, 3, 3];
  garden.add(screen);
  frame(garden);
  run(garden, 0.5);
  check('…but not in the shadow of something in the way', !heist.seen, `alarm=${heist.alarmLevel}`);
  screen.castShadows = false;
  frame(garden);
  check('…unless it casts no shadow, like the lamp housings', heist.seen);
  garden.remove(screen);
  frame(garden);

  run(garden, 3);
  check('a full alarm catches the thief…', heist.alarmLevel >= 1 || vec3.distance(thief.transform.position, [0, 0, 15]) < 0.5, `${heist.alarmLevel}`);
  run(garden, 2);
  check('…and sends them back to the start', vec3.distance(thief.transform.position, [0, 0, 15]) < 0.2 && heist.alarmLevel === 0,
    `${thief.transform.position.map((v) => v.toFixed(2))}`);
}

{
  heist.restart();
  const coins = garden.findByName('Coins')!.children;
  at([0, 0, 15]);
  check('the gate is shut while coins are left', (() => {
    at([0, 0, -19.5]);
    hold('KeyW', 1);
    return thief.transform.position[2] > -20.5;
  })(), `${thief.transform.position[2]}`);
  heist.restart();
  for (const coin of coins) {
    at(coin.transform.position);
    // Out of the lamps' way, between coins, so the alarm doesn't go off.
    at([0, 0, 15]);
  }
  eq('every coin taken', [heist.coinsTaken, coins.filter((c) => c.activeSelf).length], [coins.length, 0]);
  run(garden, 2);
  const bars = garden.findByName('Gate Bars')!;
  check('…opens the gate', bars.transform.position[1] > 4, `${bars.transform.position[1]}`);
  at([0, 0, -19.5]);
  hold('KeyW', 1);
  check('…and out through it, the thief escapes', heist.hasEscaped, `z=${thief.transform.position[2]}`);
  eq('no script errors', errors(), []);
}
garden.setRunning(false);

// ---- examples/TwilightHeist (its own git repository, when it's there) is what the builder makes now
if (!existsSync(`${root}/examples/TwilightHeist`)) {
  console.log('SKIP examples/TwilightHeist is not there (run `npm run generate:heist` to write it)');
} else {
  const saved = nodeFolder(`${root}/examples/TwilightHeist`);
  const files = await listFiles(fresh);
  const projectFiles = (await listFiles(saved)).filter((f) => f !== 'README.md' && f !== 'LICENSE');
  eq('examples/TwilightHeist has the same files (else run `npm run generate:heist` in the repo root)', projectFiles, files);
  const stale: string[] = [];
  for (const f of [...files, TYPES_PATH]) {
    const a = await fresh.read(f);
    const b = await saved.read(f).catch(() => new Uint8Array());
    if (Buffer.compare(a, b) !== 0) stale.push(f);
  }
  eq('examples/TwilightHeist is current (else run `npm run generate:heist` in the repo root)', stale, []);
}
