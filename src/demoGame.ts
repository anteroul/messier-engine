import {
  CameraComponent,
  GameObject,
  Light,
  Material,
  RigidBody,
  ScriptAsset,
  Text2D,
  createCube,
  createPlane,
  createSphere,
  fitCollider,
  type BodyType,
  type Mesh,
  type Scene,
  type Vec3,
} from './engine';

// "Gem Rush", a small game whose rules are all TypeScript scripts, as a showcase and test bed of the scripting API:
// input, physics (forces, impulses, kinematic bodies), raycasts, signals between scripts, groups, instantiate and
// destroy of hidden templates, enabling and disabling behaviours, Time.timeScale, and every lifecycle hook.
//
// Scripts can't import each other, so each one that talks to another finds it with scene.query(Script) by name and
// describes the part it uses with an interface.

const GAME_MANAGER_SCRIPT = `import { Script, Signal, Time, input, type GameObject } from 'messier';

/** Keeps the score, runs the win and restart flow, and tells everyone through signals. */
export default class GameManager extends Script {
  /** Gems needed to win. */
  goal = 10;
  /** Points lost when the ball falls off the arena. */
  fallPenalty = 2;
  /** Time scale right after winning; it eases back to 1. */
  slowMotion = 0.2;
  /** Seconds (real time) the slow motion lasts. */
  slowMotionTime = 2;
  readonly scoreChanged = new Signal<[score: number, goal: number]>();
  readonly won = new Signal<[]>();
  readonly restarted = new Signal<[]>();
  private score = 0;
  private finished = false;
  private slowTimer = 0;

  get points(): number {
    return this.score;
  }

  start(): void {
    // Groups are joined in awake(), which has run for every object by the time anything starts.
    const player = this.scene.getGroup('player')[0] as GameObject | undefined;
    const ball = player?.getComponents(Script).find((s) => s.typeName === 'PlayerBall') as unknown as PlayerApi | undefined;
    ball?.fell.connect(() => this.addPoints(-this.fallPenalty), this);
  }

  addPoints(n: number): void {
    if (this.finished) return;
    const score = Math.max(0, Math.min(this.goal, this.score + n));
    if (score === this.score) return;
    this.score = score;
    this.scoreChanged.emit(score, this.goal);
    if (score < this.goal) return;
    this.finished = true;
    this.slowTimer = this.slowMotionTime;
    Time.timeScale = this.slowMotion;
    console.log('Gem Rush: you win! Press R to play again.');
    this.won.emit();
  }

  restart(): void {
    this.score = 0;
    this.finished = false;
    this.slowTimer = 0;
    Time.timeScale = 1;
    this.scoreChanged.emit(0, this.goal);
    this.restarted.emit();
  }

  update(): void {
    if (this.slowTimer > 0) {
      // Unscaled time, or slow motion would also slow down its own timer.
      this.slowTimer = Math.max(0, this.slowTimer - Time.unscaledDeltaTime);
      const t = 1 - this.slowTimer / this.slowMotionTime;
      Time.timeScale = this.slowTimer > 0 ? this.slowMotion + (1 - this.slowMotion) * t * t : 1;
    }
    if (input.pressed('KeyR')) this.restart();
  }

  onDestroy(): void {
    // Time outlives Play, so put the clock back when the game stops.
    Time.timeScale = 1;
  }
}

interface PlayerApi {
  fell: Signal<[]>;
}
`;

const PLAYER_BALL_SCRIPT = `import { Script, Signal, input, raycastScene, vec3, type Vec3 } from 'messier';

/** Rolls the ball with WASD / arrows relative to the camera, jumps with Space and respawns after a fall. */
export default class PlayerBall extends Script {
  /** Rolling force in newtons. */
  force = 16;
  /** Upward speed of a jump, in m/s. */
  jumpSpeed = 5.5;
  /** Falling below this height counts as falling off. */
  killHeight = -5;
  /** Emitted when the ball falls off and respawns. */
  readonly fell = new Signal<[]>();
  private spawn: Vec3 = [0, 0, 0];
  private jumpQueued = false;
  private grounded = false;

  awake(): void {
    this.object.addToGroup('player');
  }

  start(): void {
    this.spawn = this.transform.worldPosition;
  }

  update(): void {
    // Read taps in update(): a frame can run zero fixed steps, and fixedUpdate() would miss the press.
    if (input.pressed('Space')) this.jumpQueued = true;
  }

  fixedUpdate(): void {
    const body = this.object.rigidBody;
    if (!body) return;
    const pos = this.transform.worldPosition;
    if (pos[1] < this.killHeight) {
      // Moving a dynamic body by hand counts as a teleport: the solver wakes it and zeroes its velocity.
      this.transform.worldPosition = this.spawn;
      this.jumpQueued = false;
      this.fell.emit();
      return;
    }

    // Camera-relative directions, flattened onto the ground.
    const cam = this.scene.activeCamera()?.transform;
    const forward = flat(cam ? cam.forward : [0, 0, -1]);
    const right = flat(cam ? cam.right : [1, 0, 0]);
    const x = input.axis('horizontal');
    const z = input.axis('vertical');
    if (x || z) body.addForce(vec3.scale(vec3.normalize(vec3.add(vec3.scale(right, x), vec3.scale(forward, z))), this.force));

    // Grounded when a physical object is right below the ball (the ray starts inside it, so skip itself).
    const hit = raycastScene(this.scene, { origin: pos, dir: [0, -1, 0] }, (o) => o !== this.object && o.rigidBody !== null);
    this.grounded = hit !== null && hit.distance < body.radius * this.transform.scale[1] + 0.1;
    if (this.jumpQueued && this.grounded) body.addImpulse([0, (this.jumpSpeed - body.velocity[1]) * body.mass, 0]);
    this.jumpQueued = false;
  }
}

function flat(v: Vec3): Vec3 {
  const f: Vec3 = [v[0], 0, v[2]];
  return vec3.length(f) > 1e-4 ? vec3.normalize(f) : [0, 0, -1];
}
`;

const FOLLOW_CAMERA_SCRIPT = `import { Script, vec3, type GameObject, type Vec3 } from 'messier';

/** Trails the player from above and behind, smoothed so physics jitter doesn't shake the view. */
export default class FollowCamera extends Script {
  height = 7;
  distance = 9;
  /** How quickly the camera catches up, per second. */
  stiffness = 4;
  private target: GameObject | null = null;

  start(): void {
    this.target = this.scene.getGroup('player')[0] ?? null;
    if (this.target) this.transform.worldPosition = this.goal(this.target.transform.worldPosition);
  }

  // After every update and physics step, so it sees where the ball ended up this frame.
  lateUpdate(dt: number): void {
    if (!this.target) return;
    const p = this.target.transform.worldPosition;
    const k = 1 - Math.exp(-this.stiffness * dt); // frame-rate independent smoothing
    this.transform.worldPosition = vec3.lerp(this.transform.worldPosition, this.goal(p), k);
    this.transform.lookAt(p);
  }

  private goal(p: Vec3): Vec3 {
    return [p[0], Math.max(p[1], 0) + this.height, p[2] + this.distance];
  }
}
`;

const GEM_SPAWNER_SCRIPT = `import { GameObject, Script, raycastScene, vec3, type Scene, type Signal, type Vec3 } from 'messier';

/** Keeps a few gems on the field by cloning a hidden template, and clears them when the round is won. */
export default class GemSpawner extends Script {
  maxGems = 4;
  /** Seconds between spawns. */
  interval = 1;
  /** Half size of the square gems appear in. */
  area = 7;
  /** Gems don't appear closer than this to the player. */
  minDistance = 3;
  private template: GameObject | null = null;
  private timer = 0;

  start(): void {
    this.template = this.find('Gem Template');
    const game = findScript<GameApi>(this.scene, 'GameManager');
    game?.won.connect(() => {
      this.enabled = false;
      // getGroup() is live: iterate a copy, as gems leave it when destroy() detaches them.
      for (const gem of [...this.scene.getGroup('gems')]) GameObject.destroy(gem);
    }, this);
    game?.restarted.connect(() => (this.enabled = true), this);
  }

  onEnable(): void {
    this.timer = this.interval;
  }

  update(dt: number): void {
    this.timer -= dt;
    if (this.timer > 0 || !this.template || this.scene.getGroup('gems').length >= this.maxGems) return;
    this.timer = this.interval;
    // The template sits under an inactive parent; the copy goes to the top level, where it is active.
    const gem = GameObject.instantiate(this.template);
    gem.name = 'Gem';
    gem.transform.worldPosition = this.randomSpot();
  }

  private randomSpot(): Vec3 {
    const player = this.scene.getGroup('player')[0];
    let spot: Vec3 = [0, 0, 0];
    for (let i = 0; i < 20; i++) {
      spot = [(Math.random() * 2 - 1) * this.area, 0.7, (Math.random() * 2 - 1) * this.area];
      if (player && vec3.distance(spot, player.transform.worldPosition) < this.minDistance) continue;
      // Only on open floor: look straight down for what's below the spot.
      const hit = raycastScene(this.scene, { origin: [spot[0], 5, spot[2]], dir: [0, -1, 0] });
      if (hit?.object.name === 'Floor') break;
    }
    return spot;
  }
}

interface GameApi {
  won: Signal<[]>;
  restarted: Signal<[]>;
}

function findScript<T>(scene: Scene, name: string): T | null {
  return (scene.query(Script).find((s) => s.typeName === name) as unknown as T | undefined) ?? null;
}
`;

const GEM_SCRIPT = `import { GameObject, Script, vec3, type Scene, type Vec3 } from 'messier';

/** Spins and bobs; the player picks it up by touching it, which scores and bursts into sparks. */
export default class Gem extends Script {
  points = 1;
  /** Degrees per second. */
  spin = 120;
  pickupRadius = 0.8;
  sparks = 12;
  private home: Vec3 = [0, 0, 0];
  private age = 0;

  awake(): void {
    this.object.addToGroup('gems');
    // Before the first render, which comes before start(). Grows in from here; not 0, which has no inverse.
    this.transform.scale = [0.01, 0.01, 0.01];
  }

  start(): void {
    this.home = vec3.clone(this.transform.position); // set by the spawner after instantiate()
    this.age = Math.random() * 10; // so gems don't bob in step
  }

  update(dt: number): void {
    this.age += dt;
    const grow = Math.min(1, this.transform.scale[0] + dt * 4);
    this.transform.scale = [grow, grow, grow];
    this.transform.setEulerDeg(20, this.age * this.spin, 0);
    this.transform.position = [this.home[0], this.home[1] + Math.sin(this.age * 2.5) * 0.15, this.home[2]];

    const player = this.scene.getGroup('player')[0];
    if (player && vec3.distance(player.transform.worldPosition, this.transform.worldPosition) < this.pickupRadius) this.collect();
  }

  collect(): void {
    findScript<GameApi>(this.scene, 'GameManager')?.addPoints(this.points);
    const template = this.find('Spark Template');
    for (let i = 0; template && i < this.sparks; i++) {
      const spark = GameObject.instantiate(template);
      spark.name = 'Spark';
      spark.transform.worldPosition = this.transform.worldPosition;
      const a = (i / this.sparks) * Math.PI * 2;
      const fx = findScript<SparkApi>(spark, 'Spark');
      fx?.launch([Math.cos(a) * 3, 3 + Math.random() * 2, Math.sin(a) * 3]);
    }
    // Deferred: this update finishes, then the gem is torn down at the end of the frame.
    GameObject.destroy(this.object);
  }
}

interface GameApi {
  addPoints(n: number): void;
}

interface SparkApi {
  launch(velocity: Vec3): void;
}

/** A script by name, on an object or anywhere live in a scene. */
function findScript<T>(where: Scene | GameObject, name: string): T | null {
  const scripts = where instanceof GameObject ? where.getComponents(Script) : where.query(Script);
  return (scripts.find((s) => s.typeName === name) as unknown as T | undefined) ?? null;
}
`;

const SPARK_SCRIPT = `import { GameObject, Script, vec3, type Vec3 } from 'messier';

/** A short-lived particle: flies, bounces off the floor, shrinks and destroys itself. */
export default class Spark extends Script {
  /** Seconds before it disappears. */
  life = 0.7;
  gravity = 14;
  private velocity: Vec3 = [0, 0, 0];
  private age = 0;
  private size = 1;

  launch(velocity: Vec3): void {
    this.velocity = vec3.clone(velocity);
  }

  start(): void {
    this.size = this.transform.scale[0];
  }

  update(dt: number): void {
    this.age += dt;
    if (this.age >= this.life) {
      GameObject.destroy(this.object);
      return;
    }
    this.velocity[1] -= this.gravity * dt;
    const p = vec3.addScaled(this.transform.position, this.velocity, dt);
    if (p[1] < 0.05 && this.velocity[1] < 0) this.velocity[1] *= -0.5;
    this.transform.position = p;
    const s = this.size * (1 - this.age / this.life);
    this.transform.scale = [s, s, s];
  }
}
`;

const SENTINEL_SCRIPT = `import { Script, vec3, type GameObject, type Scene, type Signal, type Vec3 } from 'messier';

/** A kinematic block sliding back and forth. Touching it knocks the ball away and costs a point. */
export default class Sentinel extends Script {
  /** Distance from the middle of the patrol to each end. */
  range = 4;
  /** Patrol cycles per second. */
  speed = 0.25;
  knockback = 7;
  penalty = 1;
  /** Seconds after a hit before it can hit again. */
  cooldown = 1;
  private origin: Vec3 = [0, 0, 0];
  private axis: Vec3 = [1, 0, 0];
  private phase = 0;
  private recharge = 0;
  private player: GameObject | null = null;
  private game: GameApi | null = null;

  start(): void {
    this.origin = vec3.clone(this.transform.position);
    this.axis = this.transform.right; // patrol along the block's own X axis, as placed in the editor
    this.player = this.scene.getGroup('player')[0] ?? null;
    this.game = findScript<GameApi>(this.scene, 'GameManager');
    // Sentinels rest while the round is won: disabling a behaviour stops its updates and calls onDisable().
    this.game?.won.connect(() => (this.enabled = false), this);
    this.game?.restarted.connect(() => (this.enabled = true), this);
  }

  fixedUpdate(dt: number): void {
    // Moving a kinematic body's transform is enough: the solver derives its velocity and pushes the ball.
    this.phase += dt * this.speed * Math.PI * 2;
    this.transform.position = vec3.addScaled(this.origin, this.axis, Math.sin(this.phase) * this.range);

    this.recharge = Math.max(0, this.recharge - dt);
    const body = this.player?.rigidBody;
    if (!this.player || !body || this.recharge > 0) return;
    const away = vec3.sub(this.player.transform.worldPosition, this.transform.worldPosition);
    if (vec3.length(away) > 1.05) return;
    away[1] = 0;
    body.addImpulse(vec3.scale(vec3.normalize(away), this.knockback * body.mass));
    body.addImpulse([0, 2 * body.mass, 0]);
    this.game?.addPoints(-this.penalty);
    this.recharge = this.cooldown;
  }

  update(): void {
    const m = this.object.material;
    if (m) m.emissiveStrength = 1 + 8 * (this.recharge / this.cooldown);
  }

  onDisable(): void {
    const m = this.object.material;
    if (m) m.emissiveStrength = 0.2;
  }

  onEnable(): void {
    const m = this.object.material;
    if (m) m.emissiveStrength = 1;
  }
}

interface GameApi {
  addPoints(n: number): void;
  won: Signal<[]>;
  restarted: Signal<[]>;
}

function findScript<T>(scene: Scene, name: string): T | null {
  return (scene.query(Script).find((s) => s.typeName === name) as unknown as T | undefined) ?? null;
}
`;

const SCORE_PIPS_SCRIPT = `import { Script, type Scene, type Signal } from 'messier';

/** Lights one child lamp per point, and runs a chase across them after a win. */
export default class ScorePips extends Script {
  /** Emissive strength of a lit lamp. */
  glow = 5;
  /** How fast lamps fade in and out, per second. */
  fade = 8;
  private lit = 0;
  private celebrating = false;

  start(): void {
    const game = findScript<GameApi>(this.scene, 'GameManager');
    if (!game) return;
    this.lit = game.points;
    game.scoreChanged.connect((score) => (this.lit = score), this);
    game.won.connect(() => (this.celebrating = true), this);
    game.restarted.connect(() => (this.celebrating = false), this);
  }

  update(dt: number, time: number): void {
    const lamps = this.object.children;
    const k = Math.min(1, this.fade * dt);
    lamps.forEach((lamp, i) => {
      const m = lamp.material;
      if (!m) return;
      const target = this.celebrating ? this.glow * (0.5 + 0.5 * Math.sin(time * 10 - i * 0.8)) : i < this.lit ? this.glow : 0;
      m.emissiveStrength += (target - m.emissiveStrength) * k;
    });
  }
}

interface GameApi {
  readonly points: number;
  scoreChanged: Signal<[score: number, goal: number]>;
  won: Signal<[]>;
  restarted: Signal<[]>;
}

function findScript<T>(scene: Scene, name: string): T | null {
  return (scene.query(Script).find((s) => s.typeName === name) as unknown as T | undefined) ?? null;
}
`;

const SCORE_HUD_SCRIPT = `import { Script, Text2D, type Scene, type Signal } from 'messier';

/** Writes the score and the win message into this object's Text2D, and pops the text when the score changes. */
export default class ScoreHud extends Script {
  /** Font size multiplier right after a change. */
  pop = 1.4;
  /** How fast the pop settles, per second. */
  settle = 4;
  private label: Text2D | null = null;
  private baseSize = 0;
  private boost = 0;
  private goal = 0;
  private finished = false;

  start(): void {
    this.label = this.object.getComponent(Text2D);
    if (this.label) this.baseSize = this.label.fontSize;
    const game = findScript<GameApi>(this.scene, 'GameManager');
    if (!game) return;
    this.goal = game.goal;
    this.show(game.points);
    game.scoreChanged.connect((score, goal) => {
      this.goal = goal;
      this.show(score);
      this.boost = 1;
    }, this);
    game.won.connect(() => {
      this.finished = true;
      this.show(this.goal);
    }, this);
    game.restarted.connect(() => {
      this.finished = false;
      this.show(0);
    }, this);
  }

  update(dt: number): void {
    if (!this.label) return;
    this.boost = Math.max(0, this.boost - dt * this.settle);
    this.label.fontSize = this.baseSize * (1 + (this.pop - 1) * this.boost);
  }

  private show(score: number): void {
    if (!this.label) return;
    this.label.text = this.finished ? 'You win!\\nPress R to play again' : \`Gems \${score} / \${this.goal}\`;
  }
}

interface GameApi {
  readonly points: number;
  readonly goal: number;
  scoreChanged: Signal<[score: number, goal: number]>;
  won: Signal<[]>;
  restarted: Signal<[]>;
}

function findScript<T>(scene: Scene, name: string): T | null {
  return (scene.query(Script).find((s) => s.typeName === name) as unknown as T | undefined) ?? null;
}
`;

/** Script names and sources of the demo game, in the order they're listed in the Scripts tab. */
export const DEMO_GAME_SCRIPTS: readonly (readonly [name: string, source: string])[] = [
  ['GameManager', GAME_MANAGER_SCRIPT],
  ['PlayerBall', PLAYER_BALL_SCRIPT],
  ['FollowCamera', FOLLOW_CAMERA_SCRIPT],
  ['GemSpawner', GEM_SPAWNER_SCRIPT],
  ['Gem', GEM_SCRIPT],
  ['Spark', SPARK_SCRIPT],
  ['Sentinel', SENTINEL_SCRIPT],
  ['ScorePips', SCORE_PIPS_SCRIPT],
  ['ScoreHud', SCORE_HUD_SCRIPT],
];

const ARENA_HALF = 9;

function meshObject(name: string, mesh: Mesh, material: Material, position: Vec3, scale?: Vec3): GameObject {
  const o = new GameObject(name);
  o.mesh = mesh;
  o.material = material;
  o.transform.position = position;
  if (scale) o.transform.scale = scale;
  return o;
}

function withBody(o: GameObject, type: BodyType, opts: ConstructorParameters<typeof RigidBody>[1] = {}): GameObject {
  o.rigidBody = new RigidBody(type);
  fitCollider(o.rigidBody, o.mesh);
  Object.assign(o.rigidBody, opts);
  return o;
}

/**
 * Builds the "Gem Rush" arena into `scene` and adds its scripts to `scene.scripts` (compiled). Roll the ball with
 * WASD / arrows, jump with Space, collect gems, avoid the sentinels; R restarts.
 */
export function buildDemoGame(scene: Scene): void {
  const lib = scene.scripts;
  const scripts = new Map<string, ScriptAsset>();
  for (const [name, source] of DEMO_GAME_SCRIPTS) {
    const asset = lib.get(name) ?? lib.add(new ScriptAsset(name, source));
    if (asset.compiledSource !== asset.source) asset.compile();
    scripts.set(name, asset);
  }
  const script = (name: string, overrides?: Record<string, number>) => scripts.get(name)!.create(overrides);

  scene.background = [0.02, 0.025, 0.05];
  scene.ambientColor = [0.4, 0.5, 0.8];
  scene.ambientIntensity = 0.3;
  scene.shadowExtent = 14;

  const game = new GameObject('Game');
  game.attachComponent(script('GameManager'));
  scene.add(game);

  // Arena: a floor ringed by low walls the ball can jump over (and fall off).
  const floorMat = new Material('Arena Floor', { baseColor: [0.16, 0.18, 0.24, 1], roughness: 0.7 });
  scene.add(withBody(meshObject('Floor', createPlane(ARENA_HALF * 2, 1), floorMat, [0, 0, 0]), 'static', { friction: 0.8 }));
  const wallMat = new Material('Wall', { baseColor: [0.3, 0.32, 0.4, 1], roughness: 0.5 });
  const walls = new GameObject('Walls');
  const len = ARENA_HALF * 2 + 0.4;
  const wallSpecs: [string, Vec3, Vec3][] = [
    ['North Wall', [0, 0.3, -ARENA_HALF - 0.2], [len, 0.6, 0.4]],
    ['South Wall', [0, 0.3, ARENA_HALF + 0.2], [len, 0.6, 0.4]],
    ['West Wall', [-ARENA_HALF - 0.2, 0.3, 0], [0.4, 0.6, len]],
    ['East Wall', [ARENA_HALF + 0.2, 0.3, 0], [0.4, 0.6, len]],
  ];
  for (const [name, pos, scale] of wallSpecs) walls.add(withBody(meshObject(name, createCube(1), wallMat, pos, scale), 'static'));
  const blockMat = new Material('Block', { baseColor: [0.45, 0.4, 0.6, 1], roughness: 0.4, metallic: 0.3 });
  walls.add(withBody(meshObject('Block 1', createCube(1), blockMat, [-4, 0.5, 3], [2, 1, 1]), 'static'));
  walls.add(withBody(meshObject('Block 2', createCube(1), blockMat, [4.5, 0.5, -4], [1, 1, 2.5]), 'static'));
  scene.add(walls);

  const player = meshObject('Player', createSphere(0.4), new Material('Player', { baseColor: [1, 0.45, 0.1, 1], roughness: 0.3, emissive: [1, 0.3, 0.05], emissiveStrength: 0.4 }), [0, 0.5, 5]);
  withBody(player, 'dynamic', { shape: 'sphere', mass: 1, friction: 0.9, restitution: 0.2, linearDamping: 0.4, angularDamping: 0.6 });
  player.attachComponent(script('PlayerBall'));
  scene.add(player);

  const sentinelMat = new Material('Sentinel', { baseColor: [0.6, 0.05, 0.08, 1], roughness: 0.4, emissive: [1, 0.1, 0.1], emissiveStrength: 1 });
  const sentinels = new GameObject('Sentinels');
  const s1 = withBody(meshObject('Sentinel 1', createCube(0.9), sentinelMat, [0, 0.45, -1]), 'kinematic');
  s1.attachComponent(script('Sentinel', { range: 5, speed: 0.2 }));
  const s2 = withBody(meshObject('Sentinel 2', createCube(0.9), sentinelMat, [-1, 0.45, -5.5]), 'kinematic');
  s2.transform.setEulerDeg(0, 90, 0);
  s2.attachComponent(script('Sentinel', { range: 3, speed: 0.33 }));
  sentinels.add(s1);
  sentinels.add(s2);
  scene.add(sentinels);

  const spawner = new GameObject('Gem Spawner');
  spawner.attachComponent(script('GemSpawner'));
  scene.add(spawner);

  // Templates the scripts clone with GameObject.instantiate(). Their parent is inactive, so they don't show or run.
  const prefabs = new GameObject('Prefabs');
  const gem = meshObject('Gem Template', createSphere(0.3, 6, 3), new Material('Gem', { baseColor: [0.2, 0.9, 1, 1], metallic: 0.2, roughness: 0.15, emissive: [0.1, 0.8, 1], emissiveStrength: 2 }), [0, 0, 0]);
  gem.castShadows = false;
  gem.attachComponent(script('Gem'));
  const spark = meshObject('Spark Template', createCube(0.12), new Material('Spark', { baseColor: [0.6, 1, 1, 1], emissive: [0.4, 1, 1], emissiveStrength: 6, unlit: true }), [0, 0, 0]);
  spark.castShadows = false;
  spark.attachComponent(script('Spark'));
  prefabs.add(gem);
  prefabs.add(spark);
  prefabs.setActive(false);
  scene.add(prefabs);

  // Score display along the north wall: one lamp per point of the goal.
  const pips = new GameObject('Score Pips');
  pips.transform.position = [0, 1.1, -ARENA_HALF - 0.2];
  const goal = scripts.get('GameManager')!.defaults.goal ?? 10;
  for (let i = 0; i < goal; i++) {
    const lamp = meshObject(`Pip ${i + 1}`, createSphere(0.22, 16, 8), new Material('Pip', { baseColor: [0.1, 0.12, 0.1, 1], roughness: 0.3, emissive: [0.3, 1, 0.4], emissiveStrength: 0 }), [(i - (goal - 1) / 2) * 0.7, 0, 0]);
    lamp.castShadows = false;
    pips.add(lamp);
  }
  pips.attachComponent(script('ScorePips'));
  scene.add(pips);

  // Screen-space text: the score at the top (kept current by ScoreHud), the controls at the bottom.
  const hud = new GameObject('Score HUD');
  hud.attachComponent(new Text2D({
    space: 'screen', anchor: 'top', text: `Gems 0 / ${goal}`, fontSize: 30, bold: true, color: [1, 0.93, 0.55, 1], verticalAlign: 'top',
    outlineWidth: 3, outlineColor: [0.03, 0.03, 0.08, 0.9],
  }));
  hud.transform.position = [0, -14, 0];
  hud.attachComponent(script('ScoreHud'));
  scene.add(hud);
  const help = new GameObject('Controls HUD');
  help.attachComponent(new Text2D({
    space: 'screen', anchor: 'bottom', text: 'WASD / arrows: roll   Space: jump   R: restart', fontSize: 15, color: [1, 1, 1, 0.8],
    verticalAlign: 'bottom', outlineWidth: 2, outlineColor: [0, 0, 0, 0.6],
  }));
  help.transform.position = [0, 12, 0];
  scene.add(help);

  const camera = new GameObject('Main Camera');
  camera.camera = new CameraComponent({ fovDeg: 55 });
  camera.transform.position = [0, 7, 14];
  camera.transform.lookAt([0, 0, 5]);
  camera.attachComponent(script('FollowCamera'));
  scene.add(camera);

  const sun = new Light('directional', [0.85, 0.9, 1], 1.4);
  sun.castShadows = true;
  const sunObj = new GameObject('Moon');
  sunObj.light = sun;
  sunObj.transform.position = [3, 10, 6];
  sunObj.transform.setEulerDeg(-60, 25, 0);
  scene.add(sunObj);

  const corners: [Vec3, Vec3][] = [
    [[-ARENA_HALF + 1, 2, -ARENA_HALF + 1], [1, 0.3, 0.6]],
    [[ARENA_HALF - 1, 2, -ARENA_HALF + 1], [0.3, 0.5, 1]],
    [[-ARENA_HALF + 1, 2, ARENA_HALF - 1], [0.3, 1, 0.6]],
    [[ARENA_HALF - 1, 2, ARENA_HALF - 1], [1, 0.8, 0.3]],
  ];
  const lights = new GameObject('Corner Lights');
  corners.forEach(([pos, color], i) => {
    const l = new Light('point', color, 20);
    l.range = 12;
    const o = new GameObject(`Corner Light ${i + 1}`);
    o.light = l;
    o.transform.position = pos;
    lights.add(o);
  });
  scene.add(lights);
}
