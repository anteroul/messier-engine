import { check, eq } from './harness';
import { GameObject, Scene } from '@root/src/engine/scene.ts';
import { Script } from '@root/src/engine/scripting.ts';
import { Time } from '@root/src/engine/time.ts';
import { input } from '@root/src/engine/input.ts';
import { vec3 } from '@root/src/engine/math.ts';
import { applySceneData, serializeScene } from '@root/src/engine/serialize.ts';
import { Project, ProjectResources } from '@root/src/engine/project.ts';
import { buildDemoGame, DEMO_GAME_SCRIPTS } from '@root/src/demoGame.ts';

// Plays the demo game headlessly through the same phases as Engine.step, which makes it an end-to-end test of the
// scripting API: input, physics, raycasts, signals between scripts, groups, instantiate/destroy and Time.timeScale.

// Gem spots and spark directions use Math.random(); seed it so every run plays the same game.
let seed = 1;
Math.random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

type Game = Script & { points: number; goal: number; addPoints(n: number): void };

function play(scene: Scene): void {
  Time.reset();
  Time.timeScale = 1;
  input.reset();
  scene.physics.reset(scene);
  scene.setRunning(true);
}

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

function run(scene: Scene, seconds: number): void {
  for (let t = 0; t < seconds; t += 1 / 60) frame(scene);
}

const byName = (scene: Scene, name: string) => scene.query(Script).find((s) => s.typeName === name) ?? null;

// ---- every script compiles and the scene saves and loads with its scripts attached
const built = new Scene();
buildDemoGame(built);
for (const [name] of DEMO_GAME_SCRIPTS) {
  const asset = built.scripts.get(name)!;
  check(`${name} compiles`, asset.ctor !== null && asset.diagnostics.length === 0, JSON.stringify(asset.diagnostics));
}
const warnings: string[] = [];
const data = serializeScene(built, warnings);
eq('saves without warnings', warnings, []);
const scene = new Scene(built.scripts);
applySceneData(scene, JSON.parse(JSON.stringify(data)), new ProjectResources(new Project()), warnings);
eq('loads without warnings', warnings, []);
eq('saved scene round-trips', serializeScene(scene), data);
// A script that throws is paused and its error recorded on its asset (the editor shows it in the Scripts tab).
const scriptErrors = () => scene.scripts.scripts.flatMap((a) => a.diagnostics.map((d) => `${a.name}:${d.line}: ${d.message}`));

// ---- start: the player joins its group and gems spawn from the hidden template
play(scene);
run(scene, 0.1);
const game = byName(scene, 'GameManager') as Game;
const player = scene.findByName('Player')!;
check('game manager is live', !!game);
check('player is in its group', scene.getGroup('player')[0] === player);
run(scene, 4.5);
const gems = scene.getGroup('gems');
check('gems spawned up to maxGems', gems.length === 4, `${gems.length}`);
check('gems are top-level copies, not the template', gems.every((g) => g.parent === scene.root && g.name === 'Gem' && g.activeInHierarchy));
check('templates stay inactive', !scene.findByName('Gem Template')!.activeInHierarchy);

// ---- input rolls the ball away from the camera
const start = player.transform.worldPosition;
input.keyDown('KeyW');
run(scene, 0.4);
input.keyUp('KeyW');
const moved = vec3.sub(player.transform.worldPosition, start);
check('W rolls the ball forward (−Z)', moved[2] < -0.5, `moved ${moved.map((v) => v.toFixed(2))}`);
check('ball stays on the floor', Math.abs(player.transform.worldPosition[1] - 0.4) < 0.05, `y=${player.transform.worldPosition[1]}`);

// ---- Space jumps when grounded (pressed in a frame, applied in the next fixed step)
run(scene, 0.5);
input.keyDown('Space');
frame(scene);
input.keyUp('Space');
run(scene, 0.15);
check('Space jumps', player.transform.worldPosition[1] > 0.8, `y=${player.transform.worldPosition[1]}`);
run(scene, 1.5);

// ---- touching a gem scores, bursts into sparks and destroys the gem; sparks clean themselves up
const gem = scene.getGroup('gems')[0];
const before = game.points;
player.transform.worldPosition = gem.transform.worldPosition;
frame(scene);
check('picking up a gem scores', game.points === before + 1, `${before} → ${game.points}`);
check('…and destroys it', gem.isDestroyed && !scene.getGroup('gems').includes(gem));
const sparks = () => scene.rootObjects.filter((o) => o.name === 'Spark').length;
check('…and bursts into sparks', sparks() > 0, `${sparks()}`);
run(scene, 1);
check('sparks destroy themselves', sparks() === 0, `${sparks()}`);
const pips = scene.findByName('Score Pips')!.children.filter((p) => p.material!.emissiveStrength > 1).length;
check('score pips light up', pips === game.points, `${pips} lit for ${game.points} points`);

// Gems would make the scores below depend on where they happened to spawn.
const spawner = byName(scene, 'GemSpawner')!;
spawner.enabled = false;
for (const g of [...scene.getGroup('gems')]) GameObject.destroy(g);

// ---- falling off costs points and respawns
game.addPoints(3);
const pts = game.points;
player.transform.worldPosition = [20, 3, 20];
run(scene, 2);
check('falling off respawns the ball', vec3.distance(player.transform.worldPosition, [0, 0.4, 5]) < 0.5, `${player.transform.worldPosition.map((v) => v.toFixed(2))}`);
check('…and costs points', game.points === pts - 2, `${pts} → ${game.points}`);

// ---- a sentinel knocks the ball back and costs a point
const sentinel = scene.findByName('Sentinel 1')!;
(sentinel.getComponent(Script) as Script & { speed: number }).speed = 0; // hold it still
run(scene, 0.1);
const sp = sentinel.transform.worldPosition;
// Place the ball, let the teleport settle (it zeroes velocity), then roll it at the sentinel.
player.transform.worldPosition = [sp[0], 0.4, sp[2] + 2];
run(scene, 0.3);
const p0 = game.points;
player.rigidBody!.velocity = [0, 0, -4];
run(scene, 0.4);
check('sentinel hit costs a point', game.points === p0 - 1, `${p0} → ${game.points}`);
check('…and knocks the ball away', player.rigidBody!.velocity[2] > 1, `vz=${player.rigidBody!.velocity[2].toFixed(2)}`);
spawner.enabled = true;

// ---- winning slows time, stops spawners and sentinels; R restarts
game.addPoints(game.goal);
frame(scene);
check('win slows time down', Time.timeScale < 1, `${Time.timeScale}`);
check('win clears gems', scene.getGroup('gems').length === 0);
check('win disables the spawner and sentinels', !byName(scene, 'GemSpawner') && !scene.query(Script).some((s) => s.typeName === 'Sentinel'));
run(scene, 2.5);
check('time scale eases back to 1', Time.timeScale === 1, `${Time.timeScale}`);
input.keyDown('KeyR');
frame(scene);
input.keyUp('KeyR');
check('R restarts', game.points === 0 && !!byName(scene, 'GemSpawner') && scene.query(Script).filter((s) => s.typeName === 'Sentinel').length === 2);
run(scene, 2);
check('gems spawn again', scene.getGroup('gems').length > 0);

// ---- stopping restores the clock even mid slow motion
game.addPoints(game.goal);
frame(scene);
scene.setRunning(false);
check('stopping resets the time scale', Time.timeScale === 1, `${Time.timeScale}`);

eq('no script errors', scriptErrors(), []);
