import { FakeAudioContext } from './fakeAudio';
import { check, eq } from './harness';
import { audio } from '@root/src/engine/audio.ts';
import { AudioSource, updateAudioSources } from '@root/src/engine/audioSource.ts';
import { Camera } from '@root/src/engine/camera.ts';
import { Scene } from '@root/src/engine/scene.ts';
import { Script } from '@root/src/engine/scripting.ts';
import { Text2D } from '@root/src/engine/shapes2d.ts';
import { Time } from '@root/src/engine/time.ts';
import { input } from '@root/src/engine/input.ts';
import { vec3 } from '@root/src/engine/math.ts';
import { applySceneData, serializeScene } from '@root/src/engine/serialize.ts';
import { Project, ProjectResources } from '@root/src/engine/project.ts';
import { DEMO_GAMES } from '@root/src/demos/index.ts';

// Plays the showcase games headlessly through the same phases as Engine.step. Their rules are script source strings,
// which tsc never sees, so this is what catches a typo in them.

audio.resume();
const sounds = FakeAudioContext.last!;
const listener = new Camera();

/** How many times the clip of the scene's object `name` started playing so far. */
function played(scene: Scene, name: string): number {
  const buffer = scene.findByName(name)?.getComponent(AudioSource)?.clip?._buffer;
  return buffer ? sounds.sources.filter((s) => s.started && s.buffer === buffer).length : 0;
}

let seed = 1;
Math.random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

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
  updateAudioSources(scene);
  audio.update(scene, listener);
  scene.processDestroyed();
}

function run(scene: Scene, seconds: number): void {
  for (let t = 0; t < seconds; t += 1 / 60) frame(scene);
}

function tap(scene: Scene, code: string, seconds = 1 / 60): void {
  input.keyDown(code);
  run(scene, seconds);
  input.keyUp(code);
}

/** Builds a game, checks its scripts and a save/load round trip, and returns the loaded copy, playing. */
function load(name: string): { scene: Scene; errors: () => string[]; script: <T>(typeName: string) => T } {
  const game = DEMO_GAMES.find((g) => g.name === name)!;
  const built = new Scene();
  game.build(built);
  for (const asset of built.scripts.scripts) {
    check(`${name}: ${asset.name} compiles`, asset.ctor !== null && asset.diagnostics.length === 0, JSON.stringify(asset.diagnostics));
  }
  const warnings: string[] = [];
  const data = serializeScene(built, warnings);
  eq(`${name}: saves without warnings`, warnings, []);
  const scene = new Scene(built.scripts);
  applySceneData(scene, JSON.parse(JSON.stringify(data)), new ProjectResources(new Project()), warnings);
  eq(`${name}: loads without warnings`, warnings, []);
  eq(`${name}: saved scene round-trips`, serializeScene(scene), data);
  check(`${name}: has a camera`, scene.activeCamera() !== null);
  play(scene);
  run(scene, 0.1);
  return {
    scene,
    // A script that throws is paused and its error recorded on its asset.
    errors: () => scene.scripts.scripts.flatMap((a) => a.diagnostics.map((d) => `${a.name}:${d.line}: ${d.message}`)),
    script: <T>(typeName: string) => scene.query(Script).find((s) => s.typeName === typeName) as unknown as T,
  };
}

// ---- Neon Run
{
  const { scene, errors, script } = load('Neon Run');
  const game = script<{ score: number; shieldsLeft: number; restart(): void }>('NeonRun');
  const ship = scene.findByName('Ship')!;
  const active = (name: string) => scene.findByName(name)!.children.filter((o) => o.activeSelf);
  check('Neon Run: barriers are laid out ahead', active('Barriers').length > 0 && active('Barriers').every((o) => o.transform.position[2] < -40));
  const gate = scene.findByName('Gate 1')!;
  const z0 = gate.transform.position[2];
  tap(scene, 'KeyD', 0.5);
  check('Neon Run: D steers right', ship.transform.position[0] > 1, `x=${ship.transform.position[0]}`);
  check('Neon Run: the scenery scrolls', gate.transform.position[2] !== z0);
  check('Neon Run: distance scores', game.score > 10, `${game.score}`);
  // Left alone, the ship runs into barriers until its shields are gone.
  run(scene, 90);
  eq('Neon Run: crashing uses up the shields', game.shieldsLeft, 0);
  eq('Neon Run: every crash is heard', played(scene, 'Crash Sound'), 3);
  check('Neon Run: the wreck is hidden', !ship.find('Hull')!.activeSelf);
  const final = game.score;
  run(scene, 1);
  eq('Neon Run: the score stops', game.score, final);
  tap(scene, 'KeyR');
  eq('Neon Run: R restarts', [game.shieldsLeft, game.score < 10, ship.find('Hull')!.activeSelf], [3, true, true]);
  eq('Neon Run: no script errors', errors(), []);
  scene.setRunning(false);
}

// ---- Topple
{
  const { scene, errors, script } = load('Topple');
  const game = script<{ shotsLeft: number; fallen: number; idolsFallen: number; finished: boolean }>('Topple');
  const blocks = scene.findByName('Blocks')!.children;
  const poses = blocks.map((b) => b.transform.worldPosition);
  const drift = () => Math.max(...blocks.map((b, i) => vec3.distance(b.transform.worldPosition, poses[i])));
  run(scene, 6);
  // They settle a few millimeters per contact, and no more.
  check('Topple: the stacks stand still', drift() < 0.06, `moved ${drift().toFixed(3)}`);
  check('Topple: …and fall asleep', blocks.every((b) => b.rigidBody!.sleeping));
  eq('Topple: nothing has fallen', [game.fallen, game.shotsLeft], [0, 7]);

  // A tap fires a slow ball; the aim dots lead from the muzzle.
  const muzzle = scene.findByName('Muzzle')!.transform.worldPosition;
  const dot = scene.findByName('Dot 1')!;
  check('Topple: aim dots start at the muzzle', vec3.distance(dot.transform.worldPosition, muzzle) < 1.2, `${vec3.distance(dot.transform.worldPosition, muzzle)}`);
  tap(scene, 'KeyW', 0.5);
  check('Topple: W raises the barrel', scene.findByName('Muzzle')!.transform.worldPosition[1] > muzzle[1] + 0.3);
  tap(scene, 'KeyS', 0.5);
  // A full charge straight ahead goes through the pyramid into the middle tower.
  tap(scene, 'Space', 1.3);
  frame(scene);
  const ball = scene.findByName('Balls')!.children.find((b) => b.activeSelf)!;
  check('Topple: releasing Space fires a ball', !!ball && game.shotsLeft === 6);
  check('Topple: …at speed', vec3.length(ball.rigidBody!.velocity) > 25, `${vec3.length(ball.rigidBody!.velocity)}`);
  run(scene, 5);
  check('Topple: the ball scatters the blocks', drift() > 1, `moved ${drift().toFixed(2)}`);
  check('Topple: blocks fall off the terrace', game.fallen > 0, `${game.fallen}`);
  eq('Topple: the cannon booms', played(scene, 'Cannon Sound'), 1);
  check('Topple: falling blocks are heard', played(scene, 'Fall Sound') + played(scene, 'Idol Sound') > 0);
  // Use up the shots on both sides.
  for (const key of ['KeyA', 'KeyD', 'KeyD', 'KeyA', 'KeyA', 'KeyD']) {
    tap(scene, key, 0.35);
    tap(scene, 'Space', 1.3);
    run(scene, 2);
  }
  eq('Topple: the shots run out', game.shotsLeft, 0);
  run(scene, 8);
  check('Topple: the round ends', game.finished);
  console.log(`  (${game.fallen} blocks and ${game.idolsFallen} idols down)`);
  tap(scene, 'KeyR');
  run(scene, 3);
  eq('Topple: R sets everything up again', [game.shotsLeft, game.fallen, game.finished, drift() < 0.06], [7, 0, false, true]);
  eq('Topple: no script errors', errors(), []);
  scene.setRunning(false);
}

// ---- Starfall
{
  const { scene, errors, script } = load('Starfall');
  const game = script<{ score: number; livesLeft: number }>('Starfall');
  const ship = scene.findByName('Ship')!;
  const active = (name: string) => scene.findByName(name)!.children.filter((o) => o.activeSelf);
  tap(scene, 'KeyA', 0.4);
  check('Starfall: A flies left', ship.transform.position[0] < -1, `x=${ship.transform.position[0]}`);
  tap(scene, 'KeyW', 0.3);
  check('Starfall: W flies forward', ship.transform.position[2] < 1.5, `z=${ship.transform.position[2]}`);
  input.keyDown('Space');
  run(scene, 0.5);
  check('Starfall: Space fires a stream of bolts', active('Bolts').length >= 3, `${active('Bolts').length}`);
  check('Starfall: asteroids come down the field', active('Asteroids').length > 0);
  // Sweep the field while firing: rocks get shot.
  for (let i = 0; i < 6; i++) tap(scene, i % 2 === 0 ? 'KeyD' : 'KeyA', 1.4);
  input.keyUp('Space');
  // Drifting with the guns silent, the ship is hit sooner or later.
  for (let t = 0; t < 300 && game.livesLeft > 0; t++) run(scene, 1);
  check('Starfall: shooting asteroids scores', game.score > 0, `${game.score}`);
  eq('Starfall: collisions cost lives', game.livesLeft, 0);
  check('Starfall: the guns are heard', played(scene, 'Gun Sound') >= 10, `${played(scene, 'Gun Sound')}`);
  check('Starfall: so are the explosions', played(scene, 'Boom Sound') > 0);
  eq('Starfall: and every hit taken', played(scene, 'Damage Sound'), 3);
  check('Starfall: the wreck is hidden', !ship.find('Hull')!.activeSelf);
  run(scene, 2);
  check('Starfall: sparks burn out', active('Sparks').length === 0 && active('Flashes').length === 0);
  tap(scene, 'KeyR');
  eq('Starfall: R restarts', [game.livesLeft, game.score, active('Asteroids').length], [3, 0, 0]);
  eq('Starfall: no script errors', errors(), []);
  scene.setRunning(false);
}

// ---- Arcade
{
  const { scene, errors, script } = load('Arcade');
  const menu = script<{ selectedName: string; available: boolean }>('Arcade');
  const stands = scene.findByName('Stands')!.children;
  eq('Arcade: a stand for every game', stands.map((s) => s.name), [...DEMO_GAMES.map((g) => g.name).filter((n) => n !== 'Arcade'), 'Gem Rush']);
  eq('Arcade: starts on the first game', menu.selectedName, 'Neon Run');
  tap(scene, 'KeyD');
  tap(scene, 'ArrowRight');
  eq('Arcade: D and the right arrow move along', menu.selectedName, 'Starfall');
  tap(scene, 'KeyA');
  tap(scene, 'KeyA');
  tap(scene, 'ArrowLeft');
  eq('Arcade: the choice wraps around', menu.selectedName, 'Gem Rush');
  eq('Arcade: every move clicks', played(scene, 'Select Sound'), 5);
  run(scene, 1.5);
  const spots = stands.map((s) => s.find('Spot')!.light!.intensity);
  check('Arcade: the chosen stand is lit', spots[3] > spots[0] * 4, spots.join(','));
  const camera = scene.findByName('Arcade Camera')!;
  check('Arcade: the camera follows the choice', camera.transform.position[0] > 2, `x=${camera.transform.position[0]}`);
  // Nothing is attached to sceneManager here, so no game can be started.
  check('Arcade: scenes outside the build are not playable', !menu.available);
  tap(scene, 'Enter');
  eq('Arcade: says so', scene.findByName('Status')!.getComponent(Text2D)!.text, 'Gem Rush is not in this build');
  eq('Arcade: no script errors', errors(), []);
  scene.setRunning(false);
}
