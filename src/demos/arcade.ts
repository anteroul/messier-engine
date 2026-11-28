import {
  CameraComponent,
  GameObject,
  Light,
  Material,
  Text2D,
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
import { addScripts, glow, group, hudText, lightObject, meshObject, neon, soundObject, type ScriptList } from './shared';

// "Arcade": the menu of the showcase. A dark showroom with one lit stand per game; choosing one loads its scene
// through sceneManager, and the games' ArcadeLink script comes back here.

const ARCADE_SCRIPT = `import { AudioSource, Light, Script, Text2D, audio, input, sceneManager, type GameObject, type Vec4 } from 'messier';

/** Picks a game with A/D or the arrow keys and loads its scene with Enter or Space. A stand is named after its scene. */
export default class Arcade extends Script {
  /** Turning speed of the chosen showpiece, degrees per second. */
  spinSpeed = 55;
  /** Spotlight intensity over the chosen stand, and over the others. */
  brightLight = 260;
  dimLight = 24;
  /** How fast the camera and lights follow the choice. */
  follow = 6;
  private stands: Stand[] = [];
  private index = 0;
  private focus = 0;
  private time = 0;
  private camera: GameObject | null = null;
  private status: Text2D | null = null;
  private selectSound: AudioSource | null = null;
  private launchSound: AudioSource | null = null;

  start(): void {
    const scene = this.scene;
    for (const object of scene.findByName('Stands')?.children ?? []) {
      const title = object.find('Title')?.getComponent(Text2D) ?? null;
      const blurb = object.find('Blurb')?.getComponent(Text2D) ?? null;
      this.stands.push({
        object,
        piece: object.find('Piece'),
        light: object.find('Spot')?.getComponent(Light) ?? null,
        title,
        blurb,
        titleColor: title ? [...title.color] as Vec4 : [1, 1, 1, 1],
        level: 0,
        angle: 0,
      });
    }
    this.camera = scene.findByName('Arcade Camera');
    this.status = scene.findByName('Status')?.getComponent(Text2D) ?? null;
    this.selectSound = scene.findByName('Select Sound')?.getComponent(AudioSource) ?? null;
    this.launchSound = scene.findByName('Launch Sound')?.getComponent(AudioSource) ?? null;
    // Coming back from a game, its stand is the chosen one.
    const from = Arcade.last;
    const at = this.stands.findIndex((s) => s.object.name === from);
    if (at >= 0) this.index = at;
    this.focus = this.stands[this.index]?.object.transform.position[0] ?? 0;
    this.showStatus();
  }

  /** Name of the chosen game's scene. */
  get selectedName(): string {
    return this.stands[this.index]?.object.name ?? '';
  }

  /** Whether the chosen scene is in the build that's playing. */
  get available(): boolean {
    return this.buildIndex(this.selectedName) >= 0;
  }

  update(dt: number): void {
    const count = this.stands.length;
    if (count === 0) return;
    const step = (input.pressed('KeyD') || input.pressed('ArrowRight') ? 1 : 0) - (input.pressed('KeyA') || input.pressed('ArrowLeft') ? 1 : 0);
    if (step !== 0) {
      this.index = (this.index + step + count) % count;
      this.showStatus();
      this.selectSound?.playOneShot();
    }
    if ((input.pressed('Enter') || input.pressed('Space')) && this.available && !sceneManager.isLoading) {
      Arcade.last = this.selectedName;
      // Not through the source: its sounds stop when this scene unloads, and this one should carry over.
      const launch = this.launchSound;
      if (launch?.clip) audio.play(launch.clip, { volume: launch.volume });
      void sceneManager.loadScene(this.selectedName);
    }

    this.time += dt;
    const ease = Math.min(1, dt * this.follow);
    this.stands.forEach((stand, i) => {
      stand.level += ((i === this.index ? 1 : 0) - stand.level) * ease;
      const k = stand.level;
      stand.angle = (stand.angle + dt * (10 + this.spinSpeed * k)) % 360;
      if (stand.piece) {
        const size = 0.82 + 0.18 * k;
        stand.piece.transform.setEulerDeg(0, stand.angle, 0);
        stand.piece.transform.position[1] = 1.45 + 0.18 * k + Math.sin(this.time * 2.2 + i) * 0.05;
        stand.piece.transform.scale = [size, size, size];
      }
      if (stand.light) stand.light.intensity = this.dimLight + (this.brightLight - this.dimLight) * k;
      const c = stand.titleColor;
      if (stand.title) stand.title.color = [c[0], c[1], c[2], 0.3 + 0.7 * k];
      if (stand.blurb) stand.blurb.color = [1, 1, 1, 0.85 * k];
    });

    const target = this.stands[this.index].object.transform.position[0];
    this.focus += (target - this.focus) * ease;
    if (this.camera) {
      this.camera.transform.position = [this.focus * 0.62, 2.6, 10.4];
      this.camera.transform.lookAt([this.focus, 2.05, 0]);
    }
  }

  private buildIndex(name: string): number {
    for (let i = 0; i < sceneManager.sceneCount; i++) if (sceneManager.sceneName(i) === name) return i;
    return -1;
  }

  private showStatus(): void {
    if (!this.status) return;
    this.status.text = this.available ? 'Enter: play ' + this.selectedName : this.selectedName + ' is not in this build';
    this.status.color = this.available ? [1, 1, 1, 0.9] : [1, 0.6, 0.5, 0.9];
  }

  /** The game launched last. Static, so it outlives the scene change. */
  private static last = '';
}

interface Stand {
  object: GameObject;
  piece: GameObject | null;
  light: Light | null;
  title: Text2D | null;
  blurb: Text2D | null;
  titleColor: Vec4;
  level: number;
  angle: number;
}
`;

export const ARCADE_SCRIPTS: ScriptList = [['Arcade', ARCADE_SCRIPT]];

const SPACING = 4.4;
const WALL_Z = -5.5;

function neonRunPiece(): GameObject[] {
  const plate = new Material('Mini Hull', { baseColor: [0.75, 0.8, 0.9, 1], metallic: 0.9, roughness: 0.25 });
  const ship = group('Mini Ship', [
    meshObject('Fuselage', createSphere(0.5, 24, 12), plate, [0, 0, 0], [0.5, 0.3, 1.7]),
    meshObject('Wings', createCube(1), plate, [0, -0.02, 0.3], [1.5, 0.05, 0.5]),
    meshObject('Canopy', createSphere(0.5, 16, 8), neon('Mini Canopy', [0.2, 0.9, 1], 1.2), [0, 0.1, -0.15], [0.26, 0.2, 0.6]),
    meshObject('Burner', createSphere(0.5, 16, 8), neon('Mini Burner', [1, 0.5, 0.2], 1.5), [0, 0, 0.82], [0.2, 0.2, 0.2]),
  ]);
  ship.transform.setEulerDeg(-8, 0, 14);
  const gates = [0.95, 0.72].map((radius, i) => {
    const gate = meshObject(`Gate ${i + 1}`, createTorus(radius, 0.035, 8, 64), neon(i ? 'Gate Cyan' : 'Gate Pink', i ? [0.15, 0.9, 1] : [1, 0.15, 0.75], 1.4), [0, 0, i ? -0.5 : 0.35]);
    gate.transform.setEulerDeg(90, 0, 0);
    return gate;
  });
  return [ship, ...gates];
}

function topplePiece(): GameObject[] {
  const cube = createCube(1);
  const blocks: [string, Vec4, number, number, Vec3, Vec3][] = [
    ['Marble', [0.92, 0.9, 0.86, 1], 0, 0.25, [0, -0.55, 0], [1, 0.3, 0.7]],
    ['Copper', [0.95, 0.33, 0.18, 1], 0.6, 0.3, [-0.3, -0.15, 0], [0.3, 0.5, 0.6]],
    ['Lacquer', [0.75, 0.05, 0.08, 1], 0, 0.12, [0.3, -0.15, 0], [0.3, 0.5, 0.6]],
    ['Chrome', [0.6, 0.72, 0.9, 1], 0.6, 0.15, [0, 0.22, 0], [1, 0.24, 0.7]],
  ];
  const gold = new Material('Mini Gold', { baseColor: [1, 0.6, 0.14, 1], metallic: 1, roughness: 0.22 });
  return [
    ...blocks.map(([name, baseColor, metallic, roughness, position, scale]) => meshObject(name, cube, new Material(`Mini ${name}`, { baseColor, metallic, roughness }), position, scale)),
    meshObject('Idol', createCylinder(0.16, 0.3, 24), gold, [0, 0.49, 0]),
    meshObject('Orb', createSphere(0.2, 32, 16), gold, [0, 0.8, 0]),
  ];
}

function starfallPiece(): GameObject[] {
  const tilted = group('Mini Planet', [
    meshObject('Globe', createSphere(0.6, 48, 24), new Material('Mini Globe', { baseColor: [0.1, 0.32, 0.7, 1], roughness: 0.6 }), [0, 0, 0]),
    meshObject('Ring', createTorus(1, 0.09, 4, 96), new Material('Mini Ring', { baseColor: [0.85, 0.65, 0.42, 1], roughness: 0.8 }), [0, 0, 0], [1, 0.08, 1]),
  ]);
  tilted.transform.setEulerDeg(22, 0, 14);
  const rock = new Material('Mini Rock', { baseColor: [0.4, 0.34, 0.3, 1], roughness: 0.9 });
  return [
    tilted,
    meshObject('Rock 1', createSphere(0.5, 7, 5), rock, [0.95, 0.5, 0.3], [0.3, 0.24, 0.26]),
    meshObject('Rock 2', createSphere(0.5, 6, 4), rock, [-0.8, -0.45, -0.6], [0.2, 0.2, 0.16]),
  ];
}

function gemRushPiece(): GameObject[] {
  // A sphere with this few faces is a cut gem.
  const gemMesh = createSphere(0.5, 6, 2);
  const emerald = new Material('Mini Emerald', { baseColor: [0.1, 0.9, 0.4, 1], metallic: 1, roughness: 0.18, emissive: [0.05, 0.6, 0.25], emissiveStrength: 0.35 });
  const ruby = new Material('Mini Ruby', { baseColor: [1, 0.12, 0.25, 1], metallic: 1, roughness: 0.2 });
  const ball = new Material('Mini Ball', { baseColor: [0.9, 0.9, 0.95, 1], metallic: 1, roughness: 0.1 });
  return [
    meshObject('Gem', gemMesh, emerald, [0, 0.05, 0], [1.1, 1.5, 1.1]),
    meshObject('Small Gem 1', gemMesh, ruby, [0.85, -0.3, 0.2], [0.35, 0.5, 0.35]),
    meshObject('Small Gem 2', gemMesh, ruby, [-0.6, 0.45, -0.6], [0.3, 0.42, 0.3]),
    meshObject('Ball', createSphere(0.22, 32, 16), ball, [-0.7, -0.5, 0.55]),
  ];
}

const GAMES: { name: string; blurb: string; color: Vec3; piece: () => GameObject[] }[] = [
  { name: 'Neon Run', blurb: 'Thread the gates at full speed', color: [1, 0.06, 0.62], piece: neonRunPiece },
  { name: 'Topple', blurb: 'Seven shots to clear the terrace', color: [1, 0.45, 0.05], piece: topplePiece },
  { name: 'Starfall', blurb: 'Hold the line in the asteroid belt', color: [0.08, 0.42, 1], piece: starfallPiece },
  { name: 'Gem Rush', blurb: 'Grab the gems, dodge the sentinels', color: [0.08, 0.95, 0.35], piece: gemRushPiece },
];

function buildStand(game: (typeof GAMES)[number], x: number): GameObject {
  const { name, color } = game;
  const stand = group(name, [], [x, 0, 0]);
  const dark = new Material('Pedestal', { baseColor: [0.06, 0.065, 0.08, 1], metallic: 0.8, roughness: 0.3 });
  stand.add(meshObject('Pedestal', createCylinder(1.05, 0.5, 48), dark, [0, 0.25, 0]));
  stand.add(meshObject('Trim', createTorus(1.07, 0.03, 8, 96), neon(`${name} Trim`, color, 0.95), [0, 0.5, 0]));
  stand.add(meshObject('Base Trim', createTorus(1.2, 0.02, 8, 96), neon(`${name} Trim`, color, 0.95), [0, 0.02, 0]));
  // The light pool on the floor: flat discs (bloom only spreads light past its threshold).
  const pool = glow('Pool', color, 6.5, 0.022, -5, 12);
  pool.transform.position = [0, 0.012, 0];
  pool.transform.setEulerDeg(-90, 0, 0);
  stand.add(pool);
  // A neon column on the wall behind, with its halo.
  stand.add(meshObject('Column', createCube(1), neon(`${name} Column`, color, 0.95), [0, 2.6, WALL_Z + 0.12], [0.08, 5.2, 0.06]));
  const halo = glow('Halo', color, 3, 0.02, -6, 12);
  halo.transform.position = [0, 2.6, WALL_Z + 0.1];
  halo.transform.scale = [1, 2.4, 1];
  stand.add(halo);

  stand.add(group('Piece', game.piece(), [0, 1.45, 0]));

  const spot = new Light('spot', [0.6 + 0.4 * color[0], 0.6 + 0.4 * color[1], 0.6 + 0.4 * color[2]], 24);
  spot.innerAngle = 16;
  spot.outerAngle = 30;
  const lamp = lightObject('Spot', spot, [0, 5.6, 1.8], 14);
  lamp.transform.rotation = quat.lookRotation([0, -1, -0.32]);
  stand.add(lamp);

  const title = new GameObject('Title');
  title.attachComponent(new Text2D({ text: name.toUpperCase(), fontSize: 0.5, bold: true, color: [...color, 1] as Vec4, align: 'center', outlineWidth: 0.03, outlineColor: [0, 0, 0, 0.7], order: 10 }));
  title.transform.position = [0, 3.55, 0];
  stand.add(title);
  const blurb = new GameObject('Blurb');
  blurb.attachComponent(new Text2D({ text: game.blurb, fontSize: 0.2, color: [1, 1, 1, 0], align: 'center', order: 10 }));
  blurb.transform.position = [0, 3.1, 0];
  stand.add(blurb);
  return stand;
}

/**
 * Builds the "Arcade" menu into `scene` and adds its script to `scene.scripts` (compiled). A/D or the arrow keys
 * choose a game, Enter or Space plays it.
 */
export function buildArcade(scene: Scene): void {
  const script = addScripts(scene, ARCADE_SCRIPTS);

  scene.background = [0.012, 0.012, 0.022];
  scene.ambientColor = [0.4, 0.45, 0.7];
  scene.ambientIntensity = 0.1;

  const menu = new GameObject('Menu');
  menu.attachComponent(script('Arcade'));
  scene.add(menu);

  const width = SPACING * GAMES.length + 50;
  const room = group('Room');
  room.add(meshObject('Floor', createPlane(1, 1), new Material('Showroom Floor', { baseColor: [0.05, 0.052, 0.065, 1], metallic: 0.5, roughness: 0.28 }), [0, 0, 2], [width, 1, 18]));
  room.add(meshObject('Wall', createCube(1), new Material('Showroom Wall', { baseColor: [0.035, 0.036, 0.05, 1], roughness: 0.85 }), [0, 7, WALL_Z - 0.25], [width, 14, 0.5]));
  // Floor seams running toward the wall give the dark floor some depth.
  const seam = neon('Seam', [0.07, 0.09, 0.17], 1);
  for (let i = 0; i <= GAMES.length; i++) {
    room.add(meshObject(`Seam ${i + 1}`, createCube(1), seam, [(i - GAMES.length / 2) * SPACING, 0.006, 1.5], [0.02, 0.01, 14]));
  }
  room.add(meshObject('Skirting', createCube(1), neon('Skirting', [0.12, 0.16, 0.32], 1), [0, 0.04, WALL_Z + 0.03], [width, 0.03, 0.03]));
  scene.add(room);

  const sign = new GameObject('Sign');
  sign.attachComponent(new Text2D({ text: 'MESSIER ARCADE', fontSize: 0.8, bold: true, color: [0.95, 0.97, 1, 1], align: 'center', outlineWidth: 0.05, outlineColor: [0.15, 0.3, 0.9, 0.6] }));
  sign.transform.position = [0, 6.3, WALL_Z + 0.2];
  scene.add(sign);

  const stands = group('Stands');
  GAMES.forEach((game, i) => stands.add(buildStand(game, (i - (GAMES.length - 1) / 2) * SPACING)));
  scene.add(stands);

  scene.add(group('Sounds', [soundObject('Select Sound', 'select'), soundObject('Launch Sound', 'powerup', { volume: 0.8 })]));
  scene.add(hudText('Status', 'bottom', 0, 44, { text: '', fontSize: 22, bold: true, verticalAlign: 'bottom' }));
  scene.add(hudText('Controls', 'bottom', 0, 14, { text: 'A / D or arrows: choose   Enter: play', fontSize: 14, color: [1, 1, 1, 0.7], verticalAlign: 'bottom' }));

  const camera = new GameObject('Arcade Camera');
  camera.camera = new CameraComponent({ fovDeg: 48 });
  camera.transform.position = [-SPACING * 1.5 * 0.62, 2.6, 10.4];
  camera.transform.lookAt([-SPACING * 1.5, 2.05, 0]);
  scene.add(camera);

  // A faint cool wash, so the unlit sides of the showpieces keep their shape.
  const wash = lightObject('Wash', new Light('directional', [0.5, 0.6, 1], 0.35), [0, 7, 6]);
  wash.transform.rotation = quat.lookRotation([0.25, -0.5, -0.8]);
  scene.add(wash);
}
