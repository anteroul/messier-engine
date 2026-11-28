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
} from '../engine';
import { SHARED_SCRIPTS, addScripts, group, hudText, lightObject, meshObject, neon, seeded, shapeObject, soundObject, withBody, type ScriptList } from './shared';

// "Topple": a cannon, a terrace over the sea and stacks of polished blocks with a golden idol on each. It's the
// physics engine's showcase (stacking, friction, impacts), dressed in the materials that look best in sunlight:
// gold, copper, chrome, lacquer and marble under a shadow-casting sun.

const TOPPLE_SCRIPT = `import { AudioSource, Script, Shape2D, Text2D, audio, clamp, input, vec3, type GameObject, type Quat, type Vec3 } from 'messier';

/** Aims and fires the cannon, counts what has gone over the edge, and puts everything back on R. */
export default class Topple extends Script {
  /** Aiming speed, degrees per second. */
  turnSpeed = 38;
  /** Muzzle speed of a tap, m/s. */
  minPower = 13;
  /** Muzzle speed of a full charge. */
  maxPower = 30;
  /** Seconds of holding Space for a full charge. */
  chargeTime = 1.1;
  /** Cannonballs per round. */
  shots = 7;
  /** Anything below this height has fallen off the terrace. */
  edgeHeight = -1.5;
  private pieces: Piece[] = [];
  private balls: readonly GameObject[] = [];
  private dots: readonly GameObject[] = [];
  private pips: Shape2D[] = [];
  private yawPivot: GameObject | null = null;
  private pitchPivot: GameObject | null = null;
  private muzzle: GameObject | null = null;
  private powerBar: GameObject | null = null;
  private status: Text2D | null = null;
  private message: Text2D | null = null;
  private yaw = 0;
  private pitch = 18;
  private charge = 0;
  private charging = false;
  private left = 0;
  private toppled = 0;
  private idols = 0;
  private idolsDown = 0;
  private sinceShot = 0;
  private recoil = 0;
  private over = false;
  private cannonSound: AudioSource | null = null;
  private fallSound: AudioSource | null = null;
  private idolSound: AudioSource | null = null;
  private winSound: AudioSource | null = null;

  start(): void {
    const scene = this.scene;
    for (const object of scene.findByName('Blocks')?.children ?? []) {
      const idol = object.name.startsWith('Idol');
      if (idol) this.idols++;
      this.pieces.push({ object, idol, down: false, position: vec3.clone(object.transform.position), rotation: [...object.transform.rotation] as Quat });
    }
    this.balls = scene.findByName('Balls')?.children ?? [];
    this.dots = scene.findByName('Aim Dots')?.children ?? [];
    this.yawPivot = scene.findByName('Turret');
    this.pitchPivot = this.yawPivot?.find('Cradle') ?? null;
    this.muzzle = this.pitchPivot?.find('Muzzle') ?? null;
    this.powerBar = scene.findByName('Power Fill');
    this.status = scene.findByName('Status')?.getComponent(Text2D) ?? null;
    this.message = scene.findByName('Message')?.getComponent(Text2D) ?? null;
    const sound = (name: string) => scene.findByName(name)?.getComponent(AudioSource) ?? null;
    this.cannonSound = sound('Cannon Sound');
    this.fallSound = sound('Fall Sound');
    this.idolSound = sound('Idol Sound');
    this.winSound = sound('Win Sound');
    for (const pip of scene.findByName('Shots')?.children ?? []) {
      const shape = pip.getComponent(Shape2D);
      if (shape) this.pips.push(shape);
    }
    this.restart();
  }

  get shotsLeft(): number {
    return this.left;
  }

  get fallen(): number {
    return this.toppled;
  }

  get idolsFallen(): number {
    return this.idolsDown;
  }

  get finished(): boolean {
    return this.over;
  }

  restart(): void {
    for (const piece of this.pieces) {
      const o = piece.object, body = o.rigidBody;
      piece.down = false;
      o.setActive(true);
      o.transform.position = vec3.clone(piece.position);
      o.transform.rotation = [...piece.rotation] as Quat;
      if (body) {
        body.velocity = [0, 0, 0];
        body.angularVelocity = [0, 0, 0];
        // Forget the old pose, or the solver would take the move for a teleport mid-flight.
        body.resetState();
      }
    }
    for (const ball of this.balls) ball.setActive(false);
    this.left = Math.min(this.shots, this.balls.length);
    this.toppled = this.idolsDown = 0;
    this.charge = this.sinceShot = 0;
    this.charging = this.over = false;
    if (this.message) this.message.text = '';
    this.showStatus();
  }

  update(dt: number): void {
    if (input.pressed('KeyR')) this.restart();
    this.yaw = clamp(this.yaw - input.axis('horizontal') * this.turnSpeed * dt, -38, 38);
    this.pitch = clamp(this.pitch + input.axis('vertical') * this.turnSpeed * dt, 2, 60);
    this.yawPivot?.transform.setEulerDeg(0, this.yaw, 0);
    this.pitchPivot?.transform.setEulerDeg(this.pitch, 0, 0);
    // The barrel kicks back when it fires and slides out again.
    this.recoil = Math.max(0, this.recoil - dt * 2.5);
    const barrel = this.pitchPivot?.find('Barrel');
    if (barrel) barrel.transform.position[2] = -0.9 + this.recoil * 0.45;

    if (!this.over && this.left > 0 && input.isDown('Space')) {
      this.charging = true;
      this.charge = Math.min(1, this.charge + dt / this.chargeTime);
    } else if (this.charging) {
      this.fire();
    }
    this.sinceShot += dt;
    this.showAim();
    this.watchPieces();
    if (this.powerBar) this.powerBar.transform.scale[0] = Math.max(0.001, this.charge);
  }

  private aim(): { from: Vec3; velocity: Vec3 } | null {
    if (!this.pitchPivot || !this.muzzle) return null;
    const from = this.muzzle.transform.worldPosition;
    const dir = vec3.normalize(vec3.sub(from, this.pitchPivot.transform.worldPosition));
    return { from, velocity: vec3.scale(dir, this.minPower + (this.maxPower - this.minPower) * this.charge) };
  }

  private fire(): void {
    const aim = this.aim();
    const ball = this.balls.find((b) => !b.activeSelf);
    this.charging = false;
    if (!aim || !ball || !ball.rigidBody) return;
    ball.setActive(true);
    ball.transform.position = aim.from;
    ball.rigidBody.resetState();
    ball.rigidBody.velocity = aim.velocity;
    ball.rigidBody.angularVelocity = [-6, 0, 0];
    // A full charge booms deeper.
    if (this.cannonSound) {
      this.cannonSound.pitch = 1.3 - 0.5 * this.charge;
      this.cannonSound.playOneShot();
    }
    this.charge = 0;
    this.left--;
    this.sinceShot = 0;
    this.recoil = 1;
    this.showStatus();
  }

  /** Lays the dots along the path the next ball would take. */
  private showAim(): void {
    const aim = this.aim();
    const show = !!aim && !this.over && this.left > 0;
    this.dots.forEach((dot, i) => {
      dot.setActive(show);
      if (!aim || !show) return;
      const t = 0.07 * (i + 1);
      dot.transform.position = [aim.from[0] + aim.velocity[0] * t, aim.from[1] + aim.velocity[1] * t - 4.905 * t * t, aim.from[2] + aim.velocity[2] * t];
    });
  }

  private watchPieces(): void {
    let changed = false;
    for (const piece of this.pieces) {
      const y = piece.object.transform.position[1];
      if (!piece.down && y < this.edgeHeight) {
        piece.down = changed = true;
        this.toppled++;
        if (piece.idol) this.idolsDown++;
        // Heard from where it went over (not through its source: one sound for every block).
        const clip = piece.idol ? this.idolSound?.clip : this.fallSound?.clip;
        if (clip) audio.play(clip, { position: piece.object.transform.worldPosition, volume: piece.idol ? 0.9 : 0.6, minDistance: 6, maxDistance: 70 });
      }
      // Far below, out of sight under the water.
      if (piece.object.activeSelf && y < -14) piece.object.setActive(false);
    }
    for (const ball of this.balls) {
      if (ball.activeSelf && ball.transform.position[1] < -14) ball.setActive(false);
    }
    if (changed) this.showStatus();
    if (this.over) return;
    if (this.idols > 0 && this.idolsDown >= this.idols) {
      this.finish('TERRACE CLEARED\\n' + this.left + ' shots to spare');
      this.winSound?.playOneShot();
    }
    else if (this.left === 0 && this.sinceShot > 7) this.finish('OUT OF SHOT\\n' + this.idolsDown + ' of ' + this.idols + ' idols down');
  }

  private finish(text: string): void {
    this.over = true;
    if (this.message) this.message.text = text + '\\n\\nR to set it up again';
  }

  private showStatus(): void {
    if (this.status) this.status.text = 'Idols ' + this.idolsDown + ' / ' + this.idols + '\\nBlocks ' + this.toppled;
    this.pips.forEach((pip, i) => {
      pip.fillColor[3] = i < this.left ? 1 : 0.15;
    });
  }
}

interface Piece {
  object: GameObject;
  idol: boolean;
  down: boolean;
  position: Vec3;
  rotation: Quat;
}
`;

export const TOPPLE_SCRIPTS: ScriptList = [['Topple', TOPPLE_SCRIPT]];

const SKY: Vec3 = [0.5, 0.71, 0.94];

/**
 * Builds "Topple" into `scene` and adds its scripts to `scene.scripts` (compiled). Aim with WASD or the arrow keys,
 * hold Space to charge and let go to fire; knock every golden idol off the terrace. R resets.
 */
export function buildTopple(scene: Scene): void {
  const script = addScripts(scene, [...SHARED_SCRIPTS, ...TOPPLE_SCRIPTS]);
  const random = seeded(11);

  // A daytime sky that also lights the terrace: the sea and the metals reflect it. The sea hides the sky's lower
  // half, so its warm, sunlit color only shows in reflections, where it keeps the gold golden.
  Object.assign(scene.sky, { mode: 'gradient', top: [0.04, 0.14, 0.52], horizon: [0.24, 0.43, 0.78], ground: [0.32, 0.25, 0.15], sunGlow: 0.5 });
  scene.background = SKY;
  scene.shadowDistance = 51;

  const game = new GameObject('Game');
  game.attachComponent(script('Topple'));
  game.attachComponent(script('ArcadeLink'));
  scene.add(game);

  const cube = createCube(1);
  const marble = new Material('Marble', { baseColor: [0.9, 0.88, 0.84, 1], roughness: 0.28 });
  const sandstone = new Material('Sandstone', { baseColor: [0.62, 0.5, 0.38, 1], roughness: 0.7 });
  const stone = new Material('Stone', { baseColor: [0.3, 0.27, 0.25, 1], roughness: 0.85 });
  const gold = new Material('Gold', { baseColor: [1, 0.6, 0.14, 1], metallic: 1, roughness: 0.22 });
  const copper = new Material('Copper', { baseColor: [0.95, 0.33, 0.18, 1], metallic: 1, roughness: 0.28 });
  const chrome = new Material('Chrome', { baseColor: [0.92, 0.93, 0.96, 1], metallic: 1, roughness: 0.07 });
  const lacquer = (name: string, color: Vec3) => new Material(name, { baseColor: [...color, 1], roughness: 0.18 });
  const red = lacquer('Red Lacquer', [0.75, 0.05, 0.06]);
  const teal = lacquer('Teal Lacquer', [0.03, 0.45, 0.5]);
  const ink = lacquer('Ink Lacquer', [0.03, 0.03, 0.05]);

  // The sea: a mirror for the sky. No collider, so what falls in is gone.
  scene.add(meshObject('Sea', createPlane(1200, 1), new Material('Sea', { baseColor: [0.02, 0.2, 0.35, 1], metallic: 0.9, roughness: 0.12 }), [0, -7, -200]));

  // Clouds, far behind the terrace.
  const sky = group('Sky', [], [0, 0, -420]);
  for (let i = 0; i < 9; i++) {
    const cloud = group(`Cloud ${i + 1}`, [], [(i - 4) * 120 + (random() - 0.5) * 60, 50 + random() * 110, 0]);
    for (let j = 0; j < 5; j++) {
      const w = 40 + random() * 50;
      cloud.add(shapeObject(`Puff ${j + 1}`, new Shape2D({ shape: 'ellipse', width: w, height: w * 0.42, fillColor: [1, 1, 1, 0.5], order: -20 }),
        [(j - 2) * 22 + (random() - 0.5) * 10, (random() - 0.5) * 9, 0]));
    }
    sky.add(cloud);
  }
  scene.add(sky);

  // Rock stacks standing in the sea, for a sense of distance.
  const rocks = group('Sea Stacks');
  const stacks: [Vec3, number, number][] = [[[-46, -7, -70], 9, 30], [[-60, -7, -95], 6, 20], [[52, -7, -110], 12, 40], [[30, -7, -180], 10, 26], [[-110, -7, -200], 16, 50]];
  stacks.forEach(([position, radius, height], i) => {
    rocks.add(meshObject(`Stack ${i + 1}`, createCylinder(radius, height, 9), stone, [position[0], position[1] + height / 2 - 1, position[2]]));
  });
  scene.add(rocks);

  // The terrace the stacks stand on, on four columns.
  const terrace = group('Terrace');
  terrace.add(withBody(meshObject('Deck', cube, sandstone, [0, -0.4, -1], [17, 0.8, 9]), 'static', { friction: 0.8 }));
  terrace.add(meshObject('Deck Trim', cube, gold, [0, -0.86, -1], [17.3, 0.12, 9.3]));
  for (const x of [-7, 7]) for (const z of [-4.3, 2.3]) terrace.add(meshObject('Column', createCylinder(0.6, 7, 24), marble, [x, -4.3, z]));
  scene.add(terrace);

  // Everything dynamic that counts: the script remembers where each child stands and puts it back on restart.
  const blocks = group('Blocks');
  const block = (name: string, material: Material, position: Vec3, size: Vec3, mass: number) => {
    blocks.add(withBody(meshObject(name, cube, material, position, size), 'dynamic', { mass, friction: 0.8, restitution: 0.05, linearDamping: 0.08, angularDamping: 0.3 }));
  };
  const idolMesh = createCylinder(0.42, 0.6, 32);
  const orbMesh = createSphere(0.34, 32, 16);
  const tower = (x: number, z: number, levels: number, pillar: Material, plank: Material) => {
    const pillarH = 1.3, plankH = 0.3;
    let y = 0;
    for (let level = 0; level < levels; level++) {
      // Each level is a little narrower than the one below.
      const spread = 0.95 - level * 0.08;
      // …and half as heavy: the solver only keeps a tall stack still when the weight is at the bottom.
      const mass = 2 ** (levels - 1 - level);
      for (const side of [-1, 1]) block('Pillar', pillar, [x + side * spread, y + pillarH / 2, z], [0.7, pillarH, 1], mass);
      y += pillarH;
      block('Plank', plank, [x, y + plankH / 2, z], [spread * 2 + 1.1, plankH, 1.3], mass * 1.4);
      y += plankH;
    }
    // The idol: a golden drum (a box to the physics, so it doesn't roll off by itself) with an orb on top.
    const idol = meshObject('Idol', idolMesh, gold, [x, y + 0.3, z]);
    idol.add(meshObject('Orb', orbMesh, gold, [0, 0.62, 0]));
    blocks.add(withBody(idol, 'dynamic', { mass: 0.5, friction: 0.8, restitution: 0.05, linearDamping: 0.1, angularDamping: 0.4 }));
  };
  tower(-5, -2.2, 2, red, ink);
  tower(0, -3, 3, chrome, copper);
  tower(5, -2.2, 2, teal, ink);
  // A pyramid of small blocks in front, to shoot through or over.
  const paints = [copper, marble, red, teal, chrome, gold];
  for (let row = 0; row < 4; row++) {
    for (let i = 0; i < 4 - row; i++) {
      block('Brick', paints[(row * 2 + i) % paints.length], [(i - (3 - row) / 2) * 0.86, 0.4 + row * 0.8, 1.6], [0.8, 0.8, 0.8], 0.8);
    }
  }
  scene.add(blocks);

  // The cannon on its own rock, in front of the terrace.
  const cannonZ = 8.5;
  const cannon = group('Cannon', [], [0, 0, cannonZ]);
  cannon.add(withBody(meshObject('Rock', createCylinder(2.2, 7, 10), stone, [0, -3.5, 0]), 'static'));
  cannon.add(meshObject('Base', createCylinder(1.1, 0.3, 32), ink, [0, 0.15, 0]));
  cannon.add(meshObject('Base Ring', createTorus(1.1, 0.07, 48, 12), gold, [0, 0.3, 0]));
  const turret = group('Turret', [], [0, 0.3, 0]);
  for (const side of [-1, 1]) turret.add(meshObject('Cheek', cube, copper, [side * 0.42, 0.45, 0], [0.12, 0.9, 0.9]));
  const cradle = group('Cradle', [], [0, 0.75, 0]);
  const barrel = meshObject('Barrel', createCylinder(0.27, 2.3, 32), ink, [0, 0, -0.9]);
  // Cylinders stand along Y; the cradle fires along its −Z.
  barrel.transform.setEulerDeg(90, 0, 0);
  const band = (y: number) => meshObject('Band', createTorus(0.28, 0.05, 32, 10), gold, [0, y, 0]);
  barrel.add(band(-1.1));
  barrel.add(band(-0.2));
  barrel.add(band(1.1));
  cradle.add(barrel);
  cradle.add(meshObject('Trunnion', createSphere(0.36, 24, 12), gold, [0, 0, 0]));
  cradle.add(group('Muzzle', [], [0, 0, -2.3]));
  turret.add(cradle);
  cannon.add(turret);
  scene.add(cannon);

  const balls = group('Balls');
  const ballMesh = createSphere(0.36, 32, 16);
  for (let i = 0; i < 7; i++) {
    const ball = withBody(meshObject(`Ball ${i + 1}`, ballMesh, chrome, [0, -3, cannonZ]), 'dynamic', { shape: 'sphere', mass: 7, friction: 0.5, restitution: 0.15, linearDamping: 0.02, angularDamping: 0.3 });
    ball.setActive(false);
    balls.add(ball);
  }
  scene.add(balls);
  const dots = group('Aim Dots');
  const dotMesh = createSphere(0.07, 10, 6);
  for (let i = 0; i < 14; i++) {
    const dot = meshObject(`Dot ${i + 1}`, dotMesh, neon('Aim Dot', [1, 1, 1], 1), [0, 1, cannonZ - 2 - i]);
    dot.castShadows = false;
    dots.add(dot);
  }
  scene.add(dots);

  // HUD
  scene.add(hudText('Status', 'top-left', 22, -16, { text: 'Idols 0 / 3', fontSize: 26, bold: true, color: [1, 0.86, 0.45, 1], align: 'left', verticalAlign: 'top', lineHeight: 1.2 }));
  const pips = group('Shots');
  for (let i = 0; i < 7; i++) {
    pips.add(shapeObject(`Shot ${i + 1}`, new Shape2D({ space: 'screen', anchor: 'top-right', shape: 'ellipse', width: 22, height: 22, fillColor: [0.9, 0.92, 0.96, 1], strokeWidth: 2, strokeColor: [0.1, 0.12, 0.18, 0.9] }), [-30 - i * 30, -30, 0]));
  }
  scene.add(pips);
  const power = group('Power', [], [0, 0, 0]);
  power.add(shapeObject('Power Frame', new Shape2D({ space: 'screen', anchor: 'bottom', width: 268, height: 20, cornerRadius: 10, fillColor: [0.05, 0.06, 0.1, 0.7], strokeWidth: 2, strokeColor: [1, 1, 1, 0.8] }), [0, 56, 0]));
  // The fill grows from the left: its shape is offset inside an object that the script scales along X.
  const fill = group('Power Fill', [], [-130, 56, 0]);
  fill.transform.scale = [0.001, 1, 1];
  fill.attachComponent(new Shape2D({ space: 'screen', anchor: 'bottom', shape: 'path', points: [0, -6, 260, -6, 260, 6, 0, 6], fillColor: [1, 0.72, 0.2, 1], order: 1 }));
  power.add(fill);
  scene.add(power);
  scene.add(group('Sounds', [
    soundObject('Cannon Sound', 'thump'),
    soundObject('Fall Sound', 'hit'),
    soundObject('Idol Sound', 'coin'),
    soundObject('Win Sound', 'powerup'),
  ]));
  scene.add(hudText('Message', 'center', 0, 60, { text: '', fontSize: 34, bold: true, color: [1, 0.95, 0.75, 1], align: 'center', outlineWidth: 4, outlineColor: [0.1, 0.15, 0.3, 0.9] }));
  scene.add(hudText('Controls', 'bottom', 0, 12, { text: 'WASD / arrows: aim   hold Space: charge, release: fire   R: reset   Backspace: arcade', fontSize: 14, color: [1, 1, 1, 0.85], verticalAlign: 'bottom' }));

  const camera = new GameObject('Cannon Camera');
  camera.camera = new CameraComponent({ fovDeg: 52, far: 1500 });
  camera.transform.position = [3, 4.6, cannonZ + 6];
  camera.transform.lookAt([-0.4, 1.9, 0]);
  scene.add(camera);

  const sun = new Light('directional', [1, 0.95, 0.85], 3.4);
  sun.castShadows = true;
  const sunObj = lightObject('Sun', sun, [-8, 12, 6]);
  sunObj.transform.rotation = quat.lookRotation([0.62, -0.7, -0.3]);
  scene.add(sunObj);
}
