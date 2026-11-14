import {
  CameraComponent,
  GameObject,
  Light,
  Material,
  Shape2D,
  createCube,
  createCylinder,
  createPlane,
  createSphere,
  createTorus,
  quat,
  type Scene,
  type Vec3,
  type Vec4,
} from '../engine';
import { SHARED_SCRIPTS, addScripts, glow, group, hudText, lightObject, meshObject, neon, seeded, shapeObject, type ScriptList } from './shared';

// "Neon Run": an endless runner down a glossy highway at dusk. Everything that looks like it moves is pooled and
// recycled by one script: the builder lays out a fixed set of grid lines, gates, towers, barriers and rings, and the
// script scrolls them past a ship that only ever moves sideways.

const NEON_RUN_SCRIPT = `import { CameraComponent, Script, Shape2D, Text2D, clamp, input, type GameObject } from 'messier';

/** Runs the whole game: scrolls the pooled scenery past the ship, places barriers and rings, keeps score. */
export default class NeonRun extends Script {
  /** Speed at the start, m/s. */
  startSpeed = 28;
  topSpeed = 70;
  /** Speed gained per second. */
  acceleration = 0.8;
  /** Sideways speed at full stick, m/s. */
  steerSpeed = 12;
  /** How far from the middle of the road the ship can go. */
  roadHalf = 5;
  /** Hits the ship can take. */
  shields = 3;
  /** Distance between rows of barriers. */
  rowGap = 30;
  /** Where rows appear, in front of the ship. */
  spawnDistance = 190;
  /** Points for flying through a ring. */
  ringBonus = 250;
  private ship: GameObject | null = null;
  private hull: GameObject | null = null;
  private cam: GameObject | null = null;
  private barriers: readonly GameObject[] = [];
  private rings: readonly GameObject[] = [];
  private trail: readonly GameObject[] = [];
  private scrollers: Scroller[] = [];
  private pips: Shape2D[] = [];
  private flash: Shape2D | null = null;
  private scoreText: Text2D | null = null;
  private message: Text2D | null = null;
  private camX = 0;
  private camY = 0;
  private camZ = 0;
  private x = 0;
  private vx = 0;
  private speed = 0;
  private distance = 0;
  private bonus = 0;
  private left = 0;
  private untilRow = 0;
  private safe = 0;
  private shake = 0;
  private flashAlpha = 0;
  private nextTrail = 0;
  private trailTimer = 0;
  private lastLane = 2;

  start(): void {
    const scene = this.scene;
    this.ship = scene.findByName('Ship');
    this.hull = this.ship?.find('Hull') ?? null;
    this.cam = scene.findByName('Run Camera');
    this.barriers = scene.findByName('Barriers')?.children ?? [];
    this.rings = scene.findByName('Rings')?.children ?? [];
    this.trail = scene.findByName('Trail')?.children ?? [];
    // Scenery that repeats: each group's children sit 'spacing' apart along Z and wrap around behind the camera.
    for (const name of ['Cross Lines', 'Gates', 'Towers']) {
      const parent = scene.findByName(name);
      if (!parent || parent.children.length < 2) continue;
      const spacing = Math.abs(parent.children[1].transform.position[2] - parent.children[0].transform.position[2]);
      this.scrollers.push({ items: parent.children, span: spacing * parent.children.length });
    }
    for (const pip of scene.findByName('Shields')?.children ?? []) {
      const shape = pip.getComponent(Shape2D);
      if (shape) this.pips.push(shape);
    }
    this.flash = scene.findByName('Flash')?.getComponent(Shape2D) ?? null;
    this.scoreText = scene.findByName('Score')?.getComponent(Text2D) ?? null;
    this.message = scene.findByName('Message')?.getComponent(Text2D) ?? null;
    if (this.cam) [this.camX, this.camY, this.camZ] = this.cam.transform.position;
    this.restart();
  }

  get score(): number {
    return Math.floor(this.distance) + this.bonus;
  }

  get shieldsLeft(): number {
    return this.left;
  }

  restart(): void {
    this.x = this.vx = this.distance = this.bonus = 0;
    this.speed = this.startSpeed;
    this.left = this.shields;
    this.safe = 0;
    this.shake = 0;
    for (const o of this.barriers) o.setActive(false);
    for (const o of this.rings) o.setActive(false);
    // Fill the road ahead, leaving a calm stretch to get going.
    for (let z = 70; z < this.spawnDistance; z += this.rowGap) this.spawnRow(-z);
    this.untilRow = this.rowGap;
    this.hull?.setActive(true);
    this.showShields();
    if (this.message) this.message.text = 'A / D  or  arrows to steer';
  }

  update(dt: number, time: number): void {
    if (input.pressed('KeyR')) this.restart();
    const alive = this.left > 0;
    if (alive) {
      this.speed = Math.min(this.topSpeed, this.speed + this.acceleration * dt);
      this.vx += (input.axis('horizontal') * this.steerSpeed - this.vx) * Math.min(1, dt * 9);
      this.x = clamp(this.x + this.vx * dt, -this.roadHalf, this.roadHalf);
      if (Math.abs(this.x) >= this.roadHalf) this.vx = 0;
      if (this.message && this.distance > 120) this.message.text = '';
    } else {
      this.speed *= Math.exp(-dt * 1.5);
      this.vx *= Math.exp(-dt * 4);
    }
    const move = this.speed * dt;
    this.distance += alive ? move : 0;
    this.safe = Math.max(0, this.safe - dt);

    for (const s of this.scrollers) {
      for (const o of s.items) {
        const p = o.transform.position;
        p[2] += move;
        if (p[2] > 14) p[2] -= s.span;
      }
    }
    this.untilRow -= move;
    if (this.untilRow <= 0) {
      this.spawnRow(-this.spawnDistance);
      this.untilRow += this.rowGap;
    }
    for (const o of this.barriers) {
      if (!o.activeSelf) continue;
      const p = o.transform.position, size = o.transform.scale;
      p[2] += move;
      if (p[2] > 14) o.setActive(false);
      else if (alive && this.safe <= 0 && Math.abs(p[2]) < size[2] / 2 + 0.8 && Math.abs(p[0] - this.x) < size[0] / 2 + 0.4) this.crash();
    }
    for (const o of this.rings) {
      if (!o.activeSelf) continue;
      const p = o.transform.position;
      p[2] += move;
      o.transform.setEulerDeg(0, time * 140, 0);
      if (p[2] > 14) o.setActive(false);
      else if (alive && Math.abs(p[2]) < 1 && Math.abs(p[0] - this.x) < 1.3) {
        o.setActive(false);
        this.bonus += this.ringBonus;
        this.flashAlpha = 0.18;
        this.setFlashColor(1, 0.85, 0.3);
      }
    }
    this.moveShip(dt, time, alive);
    this.moveCamera(dt, time);
    this.updateHud(dt);
  }

  private crash(): void {
    this.left--;
    this.safe = 1.6;
    this.shake = 1;
    this.flashAlpha = 0.55;
    this.setFlashColor(1, 0.15, 0.3);
    this.speed = Math.max(this.startSpeed * 0.7, this.speed * 0.6);
    this.showShields();
    if (this.left <= 0) {
      this.hull?.setActive(false);
      if (this.message) this.message.text = 'WRECKED\\nScore ' + this.score + '\\n\\nR to fly again';
    }
  }

  /** A row across the five lanes: barriers with at least one lane left open, sometimes a ring in the open one. */
  private spawnRow(z: number): void {
    // The open lane moves at most two lanes between rows, so every gap can be reached.
    const open = clamp(this.lastLane + Math.floor(Math.random() * 5) - 2, 0, 4);
    this.lastLane = open;
    const crowd = 0.35 + 0.3 * (this.speed - this.startSpeed) / Math.max(1, this.topSpeed - this.startSpeed);
    for (let lane = 0; lane < 5; lane++) {
      if (lane === open || Math.random() > crowd) continue;
      const free = this.barriers.filter((o) => !o.activeSelf);
      if (free.length === 0) break;
      const o = free[Math.floor(Math.random() * free.length)];
      o.transform.position = [(lane - 2) * 2.5, o.transform.scale[1] / 2, z];
      o.setActive(true);
    }
    if (Math.random() < 0.6) {
      const ring = this.rings.find((o) => !o.activeSelf);
      if (ring) {
        ring.transform.position = [(open - 2) * 2.5, 1, z];
        ring.setActive(true);
      }
    }
  }

  private moveShip(dt: number, time: number, alive: boolean): void {
    const ship = this.ship;
    if (!ship) return;
    ship.transform.position = [this.x, 0.75 + Math.sin(time * 3) * 0.07, 0];
    ship.transform.setEulerDeg(0, -this.vx * 1.4, -this.vx * 3.2);
    // Blink while the shield recharges.
    if (alive) this.hull?.setActive(this.safe <= 0 || Math.floor(this.safe * 12) % 2 === 0);

    // The exhaust: segments dropped behind the engine that drift back and thin out.
    this.trailTimer -= dt;
    if (alive && this.trailTimer <= 0 && this.trail.length > 0) {
      this.trailTimer = 0.03;
      const seg = this.trail[this.nextTrail];
      this.nextTrail = (this.nextTrail + 1) % this.trail.length;
      // Alternate between the two engines.
      seg.transform.position = [this.x + (this.nextTrail % 2 === 0 ? -0.3 : 0.3), 0.72, 1.6];
      seg.transform.scale = [0.16, 0.05, 1.3];
      seg.setActive(true);
    }
    for (const seg of this.trail) {
      if (!seg.activeSelf) continue;
      const s = seg.transform.scale;
      seg.transform.position[2] += this.speed * 0.35 * dt;
      s[0] -= dt * 0.4;
      if (s[0] <= 0.02) seg.setActive(false);
    }
  }

  private moveCamera(dt: number, time: number): void {
    const cam = this.cam;
    if (!cam) return;
    this.shake = Math.max(0, this.shake - dt * 2.2);
    const k = this.shake * this.shake * 0.5;
    cam.transform.position = [
      this.camX + this.x * 0.6 + Math.sin(time * 71) * k,
      this.camY + Math.sin(time * 93) * k,
      this.camZ,
    ];
    cam.transform.setEulerDeg(-7, 0, -this.vx * 0.5);
    const lens = cam.getComponent(CameraComponent);
    // The view widens with speed.
    if (lens) lens.fovDeg = 62 + 24 * (this.speed - this.startSpeed) / Math.max(1, this.topSpeed - this.startSpeed);
  }

  private updateHud(dt: number): void {
    if (this.scoreText) this.scoreText.text = String(this.score).padStart(6, '0') + '\\n' + Math.round(this.speed * 3.6) + ' km/h';
    this.flashAlpha = Math.max(0, this.flashAlpha - dt * 1.2);
    if (this.flash) this.flash.fillColor[3] = this.flashAlpha;
  }

  private setFlashColor(r: number, g: number, b: number): void {
    if (this.flash) this.flash.fillColor = [r, g, b, this.flashAlpha];
  }

  private showShields(): void {
    this.pips.forEach((pip, i) => {
      pip.fillColor[3] = i < this.left ? 1 : 0.12;
    });
  }
}

interface Scroller {
  items: readonly GameObject[];
  span: number;
}
`;

export const NEON_RUN_SCRIPTS: ScriptList = [['NeonRun', NEON_RUN_SCRIPT]];

const SKY: Vec3 = [0.035, 0.008, 0.075];
const PINK: Vec3 = [1, 0.12, 0.62];
const CYAN: Vec3 = [0.1, 0.85, 1];
const VIOLET: Vec3 = [0.55, 0.2, 1];
const GOLD: Vec3 = [1, 0.75, 0.2];
/** Depth of the backdrop: the sun, mountains and stars stand this far ahead. */
const FAR_Z = -330;

/** The slice of a disc of radius `r` between heights y0 and y1 (measured from its center), as a path. */
function discSlice(r: number, y0: number, y1: number, color: Vec4, order: number): Shape2D {
  const steps = 10;
  const right: number[] = [], left: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const y = y0 + ((y1 - y0) * i) / steps;
    const x = Math.sqrt(Math.max(0, r * r - y * y));
    right.push(x, y);
    left.unshift(-x, y);
  }
  return new Shape2D({ shape: 'path', points: [...right, ...left], fillColor: color, order });
}

/** The striped setting sun, its glow, the mountain ridges and the stars. All of it is world-space 2D far ahead. */
function buildBackdrop(): GameObject {
  const backdrop = group('Backdrop', [], [0, 0, FAR_Z]);
  const random = seeded(7);

  const stars = group('Stars');
  for (let i = 0; i < 90; i++) {
    const size = 0.5 + random() * 1.1;
    const tint = 0.6 + random() * 0.4;
    stars.add(shapeObject(`Star ${i + 1}`, new Shape2D({ width: size, height: size, fillColor: [tint, tint, 1, 0.4 + random() * 0.6], order: -30 }),
      [(random() - 0.5) * 760, 30 + random() * 220, -5]));
  }
  backdrop.add(stars);

  // A band of haze where the sky meets the ground: stacked translucent strips, densest at the horizon.
  const haze = group('Haze');
  for (let i = 0; i < 8; i++) {
    const h = 6 + i * 7;
    haze.add(shapeObject(`Haze ${i + 1}`, new Shape2D({ width: 1400, height: h, fillColor: [0.75, 0.1, 0.55, 0.07], order: -25 }), [0, h / 2, -4]));
  }
  backdrop.add(haze);

  const sun = group('Sun', [], [0, 34, 0]);
  const halo = glow('Sun Glow', [1, 0.3, 0.45], 210, 0.07, -22);
  sun.add(halo);
  const radius = 58;
  const bands = 14;
  for (let i = 0; i < bands; i++) {
    // From the top down: yellow to hot pink, with gaps that widen toward the horizon.
    const t = i / (bands - 1);
    const top = radius - (2 * radius * i) / bands, bottom = radius - (2 * radius * (i + 1)) / bands;
    const gap = t < 0.4 ? 0 : (top - bottom) * (t - 0.3) * 0.75;
    const color: Vec4 = [1, 0.86 - 0.7 * t, 0.2 + 0.45 * t, 1];
    sun.add(shapeObject(`Sun Band ${i + 1}`, discSlice(radius, bottom + gap, top, color, -20)));
  }
  backdrop.add(sun);

  // Two ridges: a far violet one and a nearer dark one with a glowing outline.
  const ridge = (name: string, z: number, height: number, fill: Vec4, stroke: Vec4, order: number) => {
    const points: number[] = [-700, -2];
    for (let x = -700; x <= 700; x += 28) {
      // Lower in the middle, so the sun shows between the peaks.
      const valley = 0.25 + 0.75 * Math.min(1, Math.abs(x) / 260);
      points.push(x, (0.35 + random() * 0.65) * height * valley);
    }
    points.push(700, -2);
    return shapeObject(name, new Shape2D({ shape: 'path', points, fillColor: fill, strokeWidth: 0.9, strokeColor: stroke, order }), [0, 0, z]);
  };
  backdrop.add(ridge('Far Ridge', 4, 70, [0.16, 0.04, 0.3, 1], [0.6, 0.25, 1, 1], -15));
  backdrop.add(ridge('Near Ridge', 12, 42, [0.05, 0.01, 0.12, 1], [...PINK, 1], -14));
  return backdrop;
}

function buildShip(): GameObject {
  const ship = group('Ship', [], [0, 0.75, 0]);
  const hull = group('Hull');
  const chrome = new Material('Ship Chrome', { baseColor: [0.85, 0.87, 0.95, 1], metallic: 1, roughness: 0.18 });
  const dark = new Material('Ship Dark', { baseColor: [0.05, 0.05, 0.09, 1], metallic: 0.7, roughness: 0.35 });
  hull.add(meshObject('Body', createSphere(0.5, 32, 16), chrome, [0, 0, 0], [0.75, 0.32, 2.3]));
  hull.add(meshObject('Canopy', createSphere(0.5, 24, 12), neon('Canopy', CYAN, 1.3), [0, 0.13, -0.15], [0.42, 0.26, 0.95]));
  for (const side of [-1, 1]) {
    const wing = meshObject(side < 0 ? 'Left Wing' : 'Right Wing', createCube(1), dark, [side * 0.62, -0.02, 0.4], [0.95, 0.06, 0.8]);
    wing.transform.setEulerDeg(0, side * -24, side * 8);
    hull.add(wing);
    hull.add(meshObject(side < 0 ? 'Left Tip' : 'Right Tip', createCube(1), neon('Wing Tip', PINK, 2.2), [side * 1.08, 0.04, 0.72], [0.06, 0.07, 0.7]));
    const engine = meshObject(side < 0 ? 'Left Engine' : 'Right Engine', createCylinder(0.13, 0.7, 20), chrome, [side * 0.3, 0, 0.95]);
    engine.transform.setEulerDeg(90, 0, 0);
    hull.add(engine);
    hull.add(meshObject(side < 0 ? 'Left Burner' : 'Right Burner', createSphere(0.12, 16, 8), neon('Burner', [1, 0.7, 0.3], 3), [side * 0.3, 0, 1.3]));
  }
  const flare = glow('Engine Glow', [1, 0.45, 0.2], 1.3, 0.1, 5);
  flare.transform.position = [0, 0, 1.32];
  hull.add(flare);
  ship.add(hull);
  // Lights the road under the ship and the barriers it passes.
  ship.add(lightObject('Underglow', new Light('point', CYAN, 14), [0, -0.3, 0.2], 9));
  return ship;
}

/**
 * Builds "Neon Run" into `scene` and adds its scripts to `scene.scripts` (compiled). Steer with A/D or the arrow
 * keys, dodge the barriers, fly through the rings; R restarts.
 */
export function buildNeonRun(scene: Scene): void {
  const script = addScripts(scene, [...SHARED_SCRIPTS, ...NEON_RUN_SCRIPTS]);
  const random = seeded(3);

  scene.background = SKY;
  scene.ambientColor = [0.55, 0.3, 0.9];
  scene.ambientIntensity = 0.2;
  scene.shadowExtent = 22;

  const game = new GameObject('Game');
  game.attachComponent(script('NeonRun'));
  game.attachComponent(script('ArcadeLink'));
  scene.add(game);

  scene.add(buildBackdrop());

  // The ground: a wet-looking sheet that mirrors the sky gradient and smears every lamp into a streak.
  const ground = new Material('Ground', { baseColor: [0.03, 0.012, 0.07, 1], metallic: 0.6, roughness: 0.24 });
  scene.add(meshObject('Ground', createPlane(700, 1), ground, [0, 0, -120]));

  // Grid: lines along the road stay put, lines across it scroll.
  const cube = createCube(1);
  const lineMat = neon('Grid Line', PINK, 1.1);
  const lanes = group('Lane Lines');
  // The road is five lanes of 2.5 m between two cyan edges.
  for (const x of [-6.25, 6.25]) lanes.add(meshObject('Road Edge', cube, neon('Road Edge', CYAN, 1.6), [x, 0.02, -150], [0.14, 0.02, 330]));
  for (let i = 1; i <= 20; i++) {
    for (const side of [-1, 1]) lanes.add(meshObject('Lane Line', cube, lineMat, [side * (6.25 + i * 7.5), 0.02, -150], [0.07, 0.02, 330]));
  }
  scene.add(lanes);
  const cross = group('Cross Lines');
  for (let i = 0; i < 34; i++) cross.add(meshObject(`Cross Line ${i + 1}`, cube, lineMat, [0, 0.02, 10 - i * 10], [300, 0.02, 0.07]));
  scene.add(cross);

  // Gates over the road, each with a lamp that sweeps over the ship as it passes under.
  const pillarMat = new Material('Gate', { baseColor: [0.06, 0.05, 0.1, 1], metallic: 0.8, roughness: 0.3 });
  const gates = group('Gates');
  for (let i = 0; i < 6; i++) {
    const color = i % 2 === 0 ? PINK : CYAN;
    const tube = neon('Gate Tube', color, 2);
    const gate = group(`Gate ${i + 1}`, [], [0, 0, 10 - i * 60]);
    for (const side of [-1, 1]) {
      gate.add(meshObject('Pillar', cube, pillarMat, [side * 8, 3.5, 0], [0.7, 7, 0.7]));
      gate.add(meshObject('Pillar Tube', cube, tube, [side * 7.6, 3.5, 0], [0.1, 7, 0.1]));
    }
    gate.add(meshObject('Beam', cube, pillarMat, [0, 7.2, 0], [16.7, 0.6, 0.7]));
    gate.add(meshObject('Beam Tube', cube, tube, [0, 6.85, 0], [15.3, 0.1, 0.1]));
    gate.add(lightObject('Gate Light', new Light('point', color, 90), [0, 5.5, 0], 30));
    gates.add(gate);
  }
  scene.add(gates);

  // A skyline on both sides: dark towers with lit window bands.
  const towerMat = new Material('Tower', { baseColor: [0.07, 0.05, 0.13, 1], metallic: 0.6, roughness: 0.35 });
  const towers = group('Towers');
  for (let i = 0; i < 28; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const w = 5 + random() * 5, h = 8 + random() * 26, d = 5 + random() * 6;
    const tower = group(`Tower ${i + 1}`, [], [side * (17 + random() * 16 + w / 2), 0, 10 - i * 12]);
    tower.add(meshObject('Block', cube, towerMat, [0, h / 2, 0], [w, h, d]));
    const color = [PINK, CYAN, VIOLET, GOLD][Math.floor(random() * 4)];
    const windows = neon('Windows', color, 1.2);
    for (let y = 3; y < h - 1; y += 3.5) tower.add(meshObject('Windows', cube, windows, [0, y, 0], [w + 0.08, 0.35, d + 0.08]));
    towers.add(tower);
  }
  scene.add(towers);

  // Pools the script draws from. Barriers come in a few shapes; the script reads each one's size from its scale.
  const barrierMat = new Material('Barrier', { baseColor: [0.09, 0.03, 0.06, 1], metallic: 0.7, roughness: 0.3 });
  const hazard = neon('Barrier Edge', [1, 0.16, 0.04], 1.3);
  const barriers = group('Barriers');
  const shapes: Vec3[] = [[2.1, 1.3, 1.2], [1.5, 3.6, 1.5], [2.3, 2.2, 0.8], [1.8, 1.8, 1.8]];
  for (let i = 0; i < 20; i++) {
    const size = shapes[i % shapes.length];
    const barrier = meshObject(`Barrier ${i + 1}`, cube, barrierMat, [0, size[1] / 2, -60], size);
    // Children inherit the scale, so these are fractions of the block.
    barrier.add(meshObject('Top Edge', cube, hazard, [0, 0.5, 0], [1.03, 0.1 / size[1], 1.03]));
    barrier.add(meshObject('Mid Edge', cube, hazard, [0, 0, 0], [1.03, 0.1 / size[1], 1.03]));
    barrier.setActive(false);
    barriers.add(barrier);
  }
  scene.add(barriers);

  const ringMesh = createTorus(0.85, 0.09, 40, 12);
  const rings = group('Rings');
  for (let i = 0; i < 8; i++) {
    // The torus lies flat; stand it up to fly through. The script spins the holder.
    const hoop = meshObject('Hoop', ringMesh, neon('Ring', [1, 0.6, 0.08], 1.3), [0, 0, 0]);
    hoop.transform.setEulerDeg(90, 0, 0);
    const core = meshObject('Core', createSphere(0.22, 16, 8), neon('Ring Core', [1, 0.8, 0.3], 1.6), [0, 0, 0]);
    const holder = group(`Ring ${i + 1}`, [hoop, core], [0, 1, -60]);
    holder.setActive(false);
    rings.add(holder);
  }
  scene.add(rings);

  const trail = group('Trail');
  for (let i = 0; i < 26; i++) {
    const seg = meshObject(`Trail ${i + 1}`, cube, neon('Trail', [1, 0.2, 0.05], 1.3), [0, 0.72, 1.6], [0.16, 0.05, 1.3]);
    seg.castShadows = false;
    seg.setActive(false);
    trail.add(seg);
  }
  scene.add(trail);

  scene.add(buildShip());

  // HUD
  scene.add(hudText('Score', 'top-left', 22, -16, { text: '000000', fontSize: 30, bold: true, color: [0.5, 0.95, 1, 1], align: 'left', verticalAlign: 'top', lineHeight: 1.15 }));
  const pips = group('Shields');
  for (let i = 0; i < 3; i++) {
    const pip = shapeObject(`Shield ${i + 1}`, new Shape2D({ space: 'screen', anchor: 'top-right', shape: 'polygon', sides: 6, width: 30, height: 30, fillColor: [...PINK, 1], strokeWidth: 2, strokeColor: [1, 0.8, 0.95, 1] }), [-34 - i * 40, -34, 0]);
    pips.add(pip);
  }
  scene.add(pips);
  scene.add(hudText('Message', 'center', 0, 70, { text: '', fontSize: 34, bold: true, color: [1, 0.9, 0.5, 1], align: 'center', outlineWidth: 4, outlineColor: [0.25, 0, 0.3, 0.9] }));
  scene.add(hudText('Controls', 'bottom', 0, 12, { text: 'A / D: steer   R: restart   Backspace: arcade', fontSize: 14, color: [1, 1, 1, 0.7], verticalAlign: 'bottom' }));
  scene.add(shapeObject('Flash', new Shape2D({ space: 'screen', anchor: 'center', width: 8000, height: 8000, fillColor: [1, 0.15, 0.3, 0], order: 50 })));

  const camera = new GameObject('Run Camera');
  camera.camera = new CameraComponent({ fovDeg: 62, far: 900 });
  camera.transform.position = [0, 2.5, 6.5];
  camera.transform.setEulerDeg(-7, 0, 0);
  scene.add(camera);

  // The low sun behind the ridge: long shadows toward the camera and a warm rim on everything.
  const sun = new Light('directional', [1, 0.55, 0.45], 2.2);
  sun.castShadows = true;
  const sunObj = lightObject('Sunset', sun, [0, 30, -60]);
  sunObj.transform.rotation = quat.lookRotation([0, -0.4, 1]);
  scene.add(sunObj);
}
