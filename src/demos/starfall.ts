import {
  CameraComponent,
  GameObject,
  Light,
  Material,
  SFX_PRESETS,
  Shape2D,
  createCube,
  createCylinder,
  createSphere,
  createTorus,
  quat,
  type Scene,
  type Vec3,
} from '../engine';
import { SHARED_SCRIPTS, addScripts, glow, group, hudText, lightObject, meshObject, neon, seeded, shapeObject, soundObject, type ScriptList } from './shared';

// "Starfall": a shooter in an asteroid field above a ringed planet. Bolts, rocks, sparks and the lights of the
// explosions are all pooled objects the script hands out; the starfield and the nebula are world-space 2D laid flat
// under the action, scrolling in two layers.

const STARFALL_SCRIPT = `import { AudioSource, Light, Script, Shape2D, Text2D, audio, clamp, input, quat, type GameObject, type Vec3 } from 'messier';

/** Flies the ship, fires bolts, sends asteroids down the field and blows them up. */
export default class Starfall extends Script {
  /** Ship speed, m/s. */
  speed = 13;
  /** Seconds between bolts while Space is held. */
  fireInterval = 0.13;
  boltSpeed = 46;
  /** Seconds between asteroids at the start, and at full difficulty. */
  spawnInterval = 0.9;
  minSpawnInterval = 0.28;
  /** Seconds until full difficulty. */
  rampTime = 90;
  lives = 3;
  /** Half the width of the field. */
  fieldHalf = 10;
  private ship: GameObject | null = null;
  private hull: GameObject | null = null;
  private bolts: readonly GameObject[] = [];
  private rocks: Rock[] = [];
  private sparks: Spark[] = [];
  private flashes: Flash[] = [];
  private layers: StarLayer[] = [];
  private pips: Shape2D[] = [];
  private scoreText: Text2D | null = null;
  private message: Text2D | null = null;
  private x = 0;
  private z = 2;
  private vx = 0;
  private points = 0;
  private left = 0;
  private elapsed = 0;
  private cooldown = 0;
  private untilRock = 0;
  private safe = 0;
  private side = 1;
  private gunSound: AudioSource | null = null;
  private hitSound: AudioSource | null = null;
  private boomSound: AudioSource | null = null;
  private damageSound: AudioSource | null = null;

  start(): void {
    const scene = this.scene;
    this.ship = scene.findByName('Ship');
    this.hull = this.ship?.find('Hull') ?? null;
    this.bolts = scene.findByName('Bolts')?.children ?? [];
    for (const object of scene.findByName('Asteroids')?.children ?? []) {
      this.rocks.push({ object, radius: 1, hp: 1, velocity: [0, 0, 0], axis: [0, 1, 0], spin: 0, angle: 0 });
    }
    for (const object of scene.findByName('Sparks')?.children ?? []) this.sparks.push({ object, velocity: [0, 0, 0], life: 0 });
    for (const object of scene.findByName('Flashes')?.children ?? []) {
      const light = object.getComponent(Light);
      if (light) this.flashes.push({ object, light, life: 0 });
    }
    // Star layers scroll at their own speed (the 'Far' one slower) and wrap around.
    for (const [name, speed] of [['Near Stars', 16], ['Far Stars', 7]] as [string, number][]) {
      const parent = scene.findByName(name);
      if (parent) this.layers.push({ items: parent.children, speed });
    }
    for (const pip of scene.findByName('Lives')?.children ?? []) {
      const shape = pip.getComponent(Shape2D);
      if (shape) this.pips.push(shape);
    }
    this.scoreText = scene.findByName('Score')?.getComponent(Text2D) ?? null;
    this.message = scene.findByName('Message')?.getComponent(Text2D) ?? null;
    const sound = (name: string) => scene.findByName(name)?.getComponent(AudioSource) ?? null;
    this.gunSound = sound('Gun Sound');
    this.hitSound = sound('Hit Sound');
    this.boomSound = sound('Boom Sound');
    this.damageSound = sound('Damage Sound');
    this.restart();
  }

  get score(): number {
    return this.points;
  }

  get livesLeft(): number {
    return this.left;
  }

  restart(): void {
    this.x = this.vx = this.points = this.elapsed = this.cooldown = this.safe = 0;
    this.z = 2;
    this.left = this.lives;
    this.untilRock = 1;
    for (const o of this.bolts) o.setActive(false);
    for (const r of this.rocks) r.object.setActive(false);
    for (const s of this.sparks) s.object.setActive(false);
    for (const f of this.flashes) f.object.setActive(false);
    this.hull?.setActive(true);
    this.showLives();
    if (this.message) this.message.text = '';
  }

  update(dt: number, time: number): void {
    if (input.pressed('KeyR')) this.restart();
    const alive = this.left > 0;
    this.elapsed += dt;
    this.safe = Math.max(0, this.safe - dt);
    if (alive) this.flyShip(dt, time);
    this.moveBolts(dt);
    this.moveRocks(dt, alive);
    this.moveEffects(dt);
    for (const layer of this.layers) {
      for (const star of layer.items) {
        const p = star.transform.position;
        // The layers lie flat: their local Y is the direction of flight.
        p[1] -= layer.speed * dt;
        if (p[1] < -90) p[1] += 440;
      }
    }
    if (this.scoreText) this.scoreText.text = String(this.points).padStart(6, '0');
  }

  private flyShip(dt: number, time: number): void {
    const ship = this.ship;
    if (!ship) return;
    const steer = input.axis('horizontal');
    this.vx += (steer * this.speed - this.vx) * Math.min(1, dt * 10);
    this.x = clamp(this.x + this.vx * dt, -this.fieldHalf + 1, this.fieldHalf - 1);
    this.z = clamp(this.z - input.axis('vertical') * this.speed * 0.7 * dt, -5, 5);
    ship.transform.position = [this.x, Math.sin(time * 2.4) * 0.08, this.z];
    ship.transform.setEulerDeg(0, 0, -this.vx * 2.6);
    this.hull?.setActive(this.safe <= 0 || Math.floor(this.safe * 12) % 2 === 0);

    this.cooldown -= dt;
    if (input.isDown('Space') && this.cooldown <= 0) {
      const bolt = this.bolts.find((b) => !b.activeSelf);
      if (bolt) {
        // Alternate between the two wing guns.
        this.side = -this.side;
        bolt.transform.position = [this.x + this.side * 0.55, 0, this.z - 0.9];
        bolt.setActive(true);
        this.cooldown = this.fireInterval;
        this.gunSound?.playOneShot();
      }
    }
  }

  private moveBolts(dt: number): void {
    for (const bolt of this.bolts) {
      if (!bolt.activeSelf) continue;
      const p = bolt.transform.position;
      p[2] -= this.boltSpeed * dt;
      if (p[2] < -42) {
        bolt.setActive(false);
        continue;
      }
      for (const rock of this.rocks) {
        if (!rock.object.activeSelf) continue;
        const q = rock.object.transform.position;
        // Bolts are long and fast: test the stretch they covered this frame.
        if (Math.abs(p[0] - q[0]) > rock.radius + 0.15 || Math.abs(p[2] - q[2]) > rock.radius + 0.6 + this.boltSpeed * dt * 0.5) continue;
        bolt.setActive(false);
        this.burst([p[0], 0, q[2] + rock.radius], 3, 0.25);
        if (--rock.hp <= 0) this.shatter(rock);
        else this.playAt(this.hitSound, [p[0], 0, q[2]], 0.5, 1);
        break;
      }
    }
  }

  private moveRocks(dt: number, alive: boolean): void {
    this.untilRock -= dt;
    if (this.untilRock <= 0) {
      const ramp = Math.min(1, this.elapsed / this.rampTime);
      this.untilRock = this.spawnInterval + (this.minSpawnInterval - this.spawnInterval) * ramp;
      this.spawnRock(ramp);
    }
    for (const rock of this.rocks) {
      const o = rock.object;
      if (!o.activeSelf) continue;
      const p = o.transform.position;
      p[0] += rock.velocity[0] * dt;
      p[2] += rock.velocity[2] * dt;
      rock.angle += rock.spin * dt;
      o.transform.rotation = quat.fromAxisAngle(rock.axis, rock.angle);
      if (p[2] > 12) o.setActive(false);
      else if (alive && this.safe <= 0 && Math.hypot(p[0] - this.x, p[2] - this.z) < rock.radius + 0.55) {
        this.shatter(rock);
        this.hit();
      }
    }
  }

  private spawnRock(ramp: number): void {
    const free = this.rocks.filter((r) => !r.object.activeSelf);
    if (free.length === 0) return;
    const rock = free[Math.floor(Math.random() * free.length)];
    const o = rock.object;
    rock.radius = 0.6 + Math.random() * Math.random() * 1.7;
    rock.hp = Math.ceil(rock.radius * 2.2);
    rock.velocity = [(Math.random() - 0.5) * 3, 0, 5 + Math.random() * 5 + ramp * 5];
    rock.axis = normalized([Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5]);
    rock.spin = (Math.random() - 0.5) * 3;
    const r = rock.radius;
    // A little lopsided, so no two look alike.
    o.transform.scale = [r * (0.8 + Math.random() * 0.4), r * (0.75 + Math.random() * 0.3), r * (0.8 + Math.random() * 0.4)];
    o.transform.position = [(Math.random() * 2 - 1) * (this.fieldHalf - 1), 0, -40];
    o.setActive(true);
  }

  private shatter(rock: Rock): void {
    const p = rock.object.transform.position;
    rock.object.setActive(false);
    this.points += Math.round(rock.radius * 10) * 10;
    this.burst([p[0], 0, p[2]], Math.round(6 + rock.radius * 7), rock.radius);
    // Big rocks boom lower and louder.
    this.playAt(this.boomSound, [p[0], 0, p[2]], 0.5 + rock.radius * 0.3, 1.5 - rock.radius * 0.35);
    const flash = this.flashes.find((f) => f.life <= 0) ?? this.flashes[0];
    if (flash) {
      flash.life = 1;
      flash.object.transform.position = [p[0], 1.2, p[2]];
      flash.object.setActive(true);
    }
  }

  /** Throws sparks out from a point. */
  private burst(at: Vec3, count: number, size: number): void {
    for (const spark of this.sparks) {
      if (count <= 0) break;
      if (spark.life > 0) continue;
      count--;
      const a = Math.random() * Math.PI * 2, v = (2 + Math.random() * 9) * (0.6 + size * 0.5);
      spark.velocity = [Math.cos(a) * v, (Math.random() - 0.3) * 5, Math.sin(a) * v + 3];
      spark.life = 0.35 + Math.random() * 0.5;
      spark.object.transform.position = [at[0], at[1], at[2]];
      spark.object.setActive(true);
    }
  }

  private moveEffects(dt: number): void {
    for (const spark of this.sparks) {
      if (spark.life <= 0) continue;
      spark.life -= dt;
      const o = spark.object, p = o.transform.position;
      p[0] += spark.velocity[0] * dt;
      p[1] += spark.velocity[1] * dt;
      p[2] += spark.velocity[2] * dt;
      const s = Math.max(0.02, Math.min(1, spark.life * 3)) * 0.22;
      o.transform.scale = [s, s, s];
      o.transform.setEulerDeg(spark.life * 500, spark.life * 300, 0);
      if (spark.life <= 0) o.setActive(false);
    }
    for (const flash of this.flashes) {
      if (flash.life <= 0) continue;
      flash.life -= dt * 2.6;
      flash.light.intensity = 260 * Math.max(0, flash.life) ** 2;
      if (flash.life <= 0) flash.object.setActive(false);
    }
  }

  /** Plays a source's clip once from a point (the source itself stays put). */
  private playAt(source: AudioSource | null, at: Vec3, volume: number, pitch: number): void {
    if (source?.clip) audio.play(source.clip, { position: at, volume: source.volume * volume, pitch, minDistance: source.minDistance, maxDistance: source.maxDistance });
  }

  private hit(): void {
    this.damageSound?.playOneShot();
    this.left--;
    this.safe = 2;
    this.burst([this.x, 0, this.z], 24, 1.5);
    this.showLives();
    if (this.left <= 0) {
      this.hull?.setActive(false);
      if (this.message) this.message.text = 'SHIP LOST\\nScore ' + this.points + '\\n\\nR to launch again';
    }
  }

  private showLives(): void {
    this.pips.forEach((pip, i) => {
      pip.fillColor[3] = i < this.left ? 1 : 0.12;
    });
  }
}

function normalized(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

interface Rock {
  object: GameObject;
  radius: number;
  hp: number;
  velocity: Vec3;
  axis: Vec3;
  spin: number;
  angle: number;
}

interface Spark {
  object: GameObject;
  velocity: Vec3;
  life: number;
}

interface Flash {
  object: GameObject;
  light: Light;
  life: number;
}

interface StarLayer {
  items: readonly GameObject[];
  speed: number;
}
`;

export const STARFALL_SCRIPTS: ScriptList = [['Starfall', STARFALL_SCRIPT]];

const SPACE: Vec3 = [0.008, 0.01, 0.03];
const CYAN: Vec3 = [0.2, 0.9, 1];
const CAMERA_POSITION: Vec3 = [0, 15, 12.5];
const CAMERA_TARGET: Vec3 = [0, 0, -3.5];
/** How far the camera looks down, in degrees. */
const CAMERA_PITCH = Math.atan2(CAMERA_POSITION[1] - CAMERA_TARGET[1], CAMERA_POSITION[2] - CAMERA_TARGET[2]) * 180 / Math.PI;

/** Stars and nebula clouds: 2D shapes on sheets that face the camera far behind the field (a sheet's Y points up the screen). */
function buildStars(): GameObject {
  const random = seeded(23);
  // Sits below the camera and is tilted like it, so local Z is the distance along the view and the stars' Y range
  // (-90 to 350, which the script wraps) is centred on the screen.
  const sky = group('Deep Space', [], [0, -80, 101.5]);
  sky.transform.setEulerDeg(-CAMERA_PITCH, 0, 0);

  const nebula = group('Nebula', [], [0, 0, -330]);
  const clouds: [Vec3, number, Vec3][] = [[[-170, 200, 0], 250, [0.5, 0.15, 0.8]], [[150, 150, 0], 210, [0.1, 0.5, 0.8]], [[-30, 60, 0], 280, [0.8, 0.2, 0.45]], [[190, 250, 0], 170, [0.25, 0.25, 0.9]]];
  clouds.forEach(([position, size, color], i) => {
    const cloud = glow(`Cloud ${i + 1}`, color, size, 0.014, -40, 22);
    cloud.transform.position = position;
    cloud.transform.scale = [1.5, 1, 1];
    nebula.add(cloud);
  });
  sky.add(nebula);

  const layer = (name: string, count: number, depth: number, spread: number, size: number) => {
    const stars = group(name, [], [0, 0, -depth]);
    for (let i = 0; i < count; i++) {
      const s = size * (0.5 + random());
      const warm = random();
      stars.add(shapeObject(`Star ${i + 1}`, new Shape2D({ shape: 'polygon', sides: 4, width: s, height: s, fillColor: [0.75 + 0.25 * warm, 0.85, 1 - 0.25 * warm, 0.5 + random() * 0.5], order: -30 }),
        [(random() - 0.5) * spread, -90 + random() * 440, 0]));
    }
    return stars;
  };
  sky.add(layer('Far Stars', 230, 310, 680, 1.2));
  sky.add(layer('Near Stars', 90, 250, 560, 1.9));
  return sky;
}

function buildShip(): GameObject {
  const ship = group('Ship', [], [0, 0, 2]);
  const hull = group('Hull');
  const plate = new Material('Hull Plate', { baseColor: [0.8, 0.82, 0.88, 1], metallic: 0.9, roughness: 0.25 });
  const dark = new Material('Hull Dark', { baseColor: [0.08, 0.09, 0.13, 1], metallic: 0.6, roughness: 0.4 });
  const stripe = new Material('Hull Stripe', { baseColor: [0.9, 0.2, 0.08, 1], roughness: 0.3 });
  hull.add(meshObject('Fuselage', createSphere(0.5, 32, 16), plate, [0, 0, 0], [0.7, 0.45, 2.6]));
  hull.add(meshObject('Canopy', createSphere(0.5, 24, 12), neon('Canopy', CYAN, 1.2), [0, 0.14, -0.3], [0.36, 0.26, 0.9]));
  for (const side of [-1, 1]) {
    const wing = meshObject(side < 0 ? 'Left Wing' : 'Right Wing', createCube(1), plate, [side * 0.75, -0.02, 0.35], [1.3, 0.07, 0.9]);
    wing.transform.setEulerDeg(0, side * -28, 0);
    hull.add(wing);
    hull.add(meshObject(side < 0 ? 'Left Stripe' : 'Right Stripe', createCube(1), stripe, [side * 0.75, 0.025, 0.35], [1.32, 0.02, 0.22])).transform.setEulerDeg(0, side * -28, 0);
    const gun = meshObject(side < 0 ? 'Left Gun' : 'Right Gun', createCylinder(0.06, 1.1, 12), dark, [side * 0.55, 0, -0.5]);
    gun.transform.setEulerDeg(90, 0, 0);
    hull.add(gun);
    const engine = meshObject(side < 0 ? 'Left Engine' : 'Right Engine', createCylinder(0.16, 0.6, 20), dark, [side * 0.28, 0, 1.05]);
    engine.transform.setEulerDeg(90, 0, 0);
    hull.add(engine);
    hull.add(meshObject(side < 0 ? 'Left Burner' : 'Right Burner', createSphere(0.14, 16, 8), neon('Burner', [0.5, 0.8, 1], 2.5), [side * 0.28, 0, 1.36]));
  }
  hull.add(meshObject('Fin', createCube(1), stripe, [0, 0.3, 0.8], [0.05, 0.5, 0.6]));
  // The glow lies flat like the stars, so the camera above sees it as a disc.
  const flare = glow('Engine Glow', [0.3, 0.7, 1], 2.2, 0.12, 5);
  flare.transform.position = [0, 0.05, 1.6];
  flare.transform.setEulerDeg(-90, 0, 0);
  flare.transform.scale = [0.8, 1.6, 1];
  hull.add(flare);
  ship.add(hull);
  // On the ship, so the guns pan left and right with it.
  ship.add(soundObject('Gun Sound', 'laser', { spatial: true, minDistance: 14, maxDistance: 90, volume: 0.7 }));
  ship.add(lightObject('Engine Light', new Light('point', [0.4, 0.75, 1], 10), [0, 0.4, 1.8], 7));
  return ship;
}

/**
 * Builds "Starfall" into `scene` and adds its scripts to `scene.scripts` (compiled). Fly with WASD or the arrow
 * keys, hold Space to fire; R restarts.
 */
export function buildStarfall(scene: Scene): void {
  const script = addScripts(scene, [...SHARED_SCRIPTS, ...STARFALL_SCRIPTS]);

  scene.background = SPACE;
  scene.ambientColor = [0.35, 0.45, 0.8];
  scene.ambientIntensity = 0.12;
  scene.shadowDistance = 48;

  const game = new GameObject('Game');
  game.attachComponent(script('Starfall'));
  game.attachComponent(script('ArcadeLink'));
  scene.add(game);

  scene.add(buildStars());

  // A planet whose limb fills the lower right corner, lit from behind into a crescent, with its ring and a moon.
  const planet = group('Planet', [], [150, -224, -38]);
  planet.add(meshObject('Globe', createSphere(1, 96, 48), new Material('Planet', { baseColor: [0.07, 0.24, 0.42, 1], roughness: 1 }), [0, 0, 0], [120, 120, 120]));
  // Tori squashed flat: with four sides around the tube they make clean bands.
  const ringMat = new Material('Planet Ring', { baseColor: [0.75, 0.58, 0.4, 1], roughness: 1 });
  planet.add(meshObject('Outer Ring', createTorus(1, 0.06, 4, 160), ringMat, [0, 0, 0], [176, 2, 176]));
  planet.add(meshObject('Inner Ring', createTorus(1, 0.035, 4, 160), ringMat, [0, 0, 0], [152, 2, 152]));
  planet.transform.setEulerDeg(-CAMERA_PITCH + 14, 0, 18);
  scene.add(planet);
  scene.add(meshObject('Moon', createSphere(1, 40, 20), new Material('Moon', { baseColor: [0.5, 0.47, 0.45, 1], roughness: 1 }), [-90, -58, -124], [7, 7, 7]));

  // Pools.
  const rockMesh = createSphere(1, 9, 6);
  const rockMats = [
    new Material('Rock', { baseColor: [0.32, 0.28, 0.25, 1], roughness: 0.9 }),
    new Material('Rust Rock', { baseColor: [0.45, 0.22, 0.14, 1], roughness: 0.85 }),
    new Material('Ore', { baseColor: [1, 0.62, 0.2, 1], metallic: 1, roughness: 0.38 }),
    new Material('Ice', { baseColor: [0.6, 0.85, 0.95, 1], metallic: 0.2, roughness: 0.15 }),
    new Material('Rock', { baseColor: [0.22, 0.22, 0.26, 1], roughness: 0.8 }),
  ];
  const rocks = group('Asteroids');
  for (let i = 0; i < 26; i++) {
    const rock = meshObject(`Asteroid ${i + 1}`, rockMesh, rockMats[i % rockMats.length], [0, 0, -40]);
    rock.setActive(false);
    rocks.add(rock);
  }
  scene.add(rocks);

  const cube = createCube(1);
  const bolts = group('Bolts');
  for (let i = 0; i < 24; i++) {
    const bolt = meshObject(`Bolt ${i + 1}`, cube, neon('Bolt', [0.15, 1, 0.55], 1.5), [0, 0, 0], [0.13, 0.13, 1.7]);
    bolt.setActive(false);
    bolts.add(bolt);
  }
  scene.add(bolts);
  const sparks = group('Sparks');
  for (let i = 0; i < 70; i++) {
    const spark = meshObject(`Spark ${i + 1}`, cube, neon('Spark', i % 3 === 0 ? [1, 0.9, 0.6] : [1, 0.45, 0.1], 1.6), [0, 0, 0], [0.2, 0.2, 0.2]);
    spark.setActive(false);
    sparks.add(spark);
  }
  scene.add(sparks);
  const flashes = group('Flashes');
  for (let i = 0; i < 4; i++) {
    const flash = lightObject(`Flash ${i + 1}`, new Light('point', [1, 0.6, 0.25], 0), [0, 1.2, 0], 16);
    flash.setActive(false);
    flashes.add(flash);
  }
  scene.add(flashes);

  scene.add(buildShip());

  // HUD
  scene.add(hudText('Score', 'top-left', 22, -16, { text: '000000', fontSize: 30, bold: true, color: [0.6, 1, 0.9, 1], align: 'left', verticalAlign: 'top' }));
  const pips = group('Lives');
  for (let i = 0; i < 3; i++) {
    pips.add(shapeObject(`Life ${i + 1}`, new Shape2D({ space: 'screen', anchor: 'top-right', shape: 'polygon', sides: 3, width: 28, height: 30, fillColor: [0.6, 1, 0.9, 1], strokeWidth: 2, strokeColor: [0.05, 0.2, 0.25, 1] }), [-34 - i * 38, -36, 0]));
  }
  scene.add(pips);
  // Heard from the field: the camera hangs about 15 m above it.
  const field = { spatial: true, minDistance: 14, maxDistance: 90 };
  scene.add(group('Sounds', [
    soundObject('Hit Sound', 'hit', field),
    soundObject('Boom Sound', 'explosion', field),
    soundObject('Damage Sound', { ...SFX_PRESETS.explosion, frequency: 900, decay: 1.2, volume: 1 }),
  ]));
  scene.add(hudText('Message', 'center', 0, 40, { text: '', fontSize: 34, bold: true, color: [1, 0.85, 0.55, 1], align: 'center', outlineWidth: 4, outlineColor: [0.25, 0.05, 0, 0.9] }));
  scene.add(hudText('Controls', 'bottom', 0, 12, { text: 'WASD / arrows: fly   Space: fire   R: restart   Backspace: arcade', fontSize: 14, color: [1, 1, 1, 0.7], verticalAlign: 'bottom' }));

  const camera = new GameObject('Chase Camera');
  camera.camera = new CameraComponent({ fovDeg: 50, far: 600 });
  camera.transform.position = CAMERA_POSITION;
  camera.transform.lookAt(CAMERA_TARGET);
  scene.add(camera);

  const sun = lightObject('Star Light', new Light('directional', [1, 0.93, 0.82], 3.2), [14, 10, -6]);
  sun.transform.rotation = quat.lookRotation([-0.8, -0.45, 0.35]);
  scene.add(sun);
  // A cool fill from the other side, so the shadowed halves aren't black.
  const fill = lightObject('Planet Shine', new Light('directional', [0.25, 0.5, 0.9], 0.5), [-14, -6, 0]);
  fill.transform.rotation = quat.lookRotation([0.7, 0.6, -0.2]);
  scene.add(fill);
}
