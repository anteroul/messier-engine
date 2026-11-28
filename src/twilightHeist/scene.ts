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
  vec3,
  type Scene,
  type Vec3,
} from '../engine';
import { addScripts, group, hudText, lightObject, meshObject, seeded, shapeObject, soundObject } from '../demos/shared';
import { HEIST_SCRIPTS } from './scripts';

// "Twilight Heist": a walled castle garden at dusk. A thief (the player) takes the coins hidden around it and slips
// out through the gate, while lamps on three watchtowers sweep the lawns. What a lamp lights sees the thief, so the
// shadows are the game: of hedges and statues in the lamps' beams (spot light shadows), of the brazier in the middle
// (a point light's), and the long ones of the setting sun across the whole garden (cascades). Stained-glass windows,
// the pond, the flames and the fireflies are blended materials.
//
// The garden is 40 m square, centered on the origin; the gate is in the north wall (−Z), the thief starts in the south.

const HALF = 20;
const WALL_HEIGHT = 3.2;

/** Compass heading (degrees, 0 = −Z, 90 = +X) from `from` to `to`, as the Searchlight script reads it. */
function heading(from: Vec3, to: Vec3): number {
  return (Math.atan2(to[0] - from[0], -(to[2] - from[2])) * 180) / Math.PI;
}

export function buildGarden(scene: Scene): void {
  const script = addScripts(scene, HEIST_SCRIPTS);
  const random = seeded(7);

  // Dusk: a deep blue sky over an orange horizon, which also lights the garden (dimly: the lamps are the bright part).
  Object.assign(scene.sky, {
    mode: 'gradient',
    top: [0.02, 0.035, 0.12],
    horizon: [0.55, 0.22, 0.1],
    ground: [0.04, 0.03, 0.03],
    sunSize: 2.2,
    sunGlow: 0.8,
    lighting: 0.35,
  });
  scene.background = [0.02, 0.03, 0.08];
  scene.shadowDistance = 60;
  scene.shadowCascades = 4;
  scene.exposure = 1.1;

  const game = new GameObject('Game');
  game.attachComponent(script('Heist'));
  scene.add(game);

  const cube = createCube(1);
  const stone = new Material('Castle Stone', { baseColor: [0.42, 0.38, 0.34, 1], roughness: 0.9 });
  const darkStone = new Material('Dark Stone', { baseColor: [0.22, 0.2, 0.19, 1], roughness: 0.85 });
  const marble = new Material('Marble', { baseColor: [0.85, 0.83, 0.78, 1], roughness: 0.35 });
  const hedge = new Material('Hedge', { baseColor: [0.06, 0.2, 0.06, 1], roughness: 0.95 });
  const grass = new Material('Lawn', { baseColor: [0.12, 0.24, 0.08, 1], roughness: 1 });
  const gravel = new Material('Gravel', { baseColor: [0.45, 0.4, 0.33, 1], roughness: 1 });
  const iron = new Material('Iron', { baseColor: [0.08, 0.08, 0.09, 1], metallic: 1, roughness: 0.55 });
  const wood = new Material('Wood', { baseColor: [0.3, 0.17, 0.08, 1], roughness: 0.8 });
  const roof = new Material('Slate', { baseColor: [0.13, 0.13, 0.17, 1], roughness: 0.7 });
  const gold = new Material('Gold', { baseColor: [1, 0.68, 0.2, 1], metallic: 1, roughness: 0.25, emissive: [1, 0.6, 0.15], emissiveStrength: 0.15 });

  // The ground: lawn far past the walls (so the sun's shadows have somewhere to fall), gravel paths inside.
  const ground = meshObject('Lawn', createPlane(240), grass, [0, 0, 0]);
  ground.castShadows = false;
  scene.add(ground);
  const paths = group('Paths');
  const path = (name: string, x: number, z: number, w: number, d: number) => {
    const p = meshObject(name, cube, gravel, [x, 0.01, z], [w, 0.02, d]);
    p.castShadows = false;
    paths.add(p);
  };
  path('Main Path', 0, 0, 3, 40);
  path('Cross Path', 0, -4, 30, 2.4);
  scene.add(paths);

  // Everything the thief walks into, as leaf meshes (the Heist script makes a box of each).
  const solid = group('Solid');
  const block = (parent: GameObject, name: string, material: Material, center: Vec3, size: Vec3) =>
    parent.add(meshObject(name, cube, material, center, size));

  // The walls, with the gate in the north one.
  const walls = group('Walls');
  const wall = (name: string, x0: number, x1: number, z0: number, z1: number) =>
    block(walls, name, stone, [(x0 + x1) / 2, WALL_HEIGHT / 2, (z0 + z1) / 2], [x1 - x0, WALL_HEIGHT, z1 - z0]);
  wall('North Wall West', -HALF - 1, -1.6, -HALF - 1, -HALF);
  wall('North Wall East', 1.6, HALF + 1, -HALF - 1, -HALF);
  wall('South Wall', -HALF - 1, HALF + 1, HALF, HALF + 1);
  wall('West Wall', -HALF - 1, -HALF, -HALF, HALF);
  wall('East Wall', HALF, HALF + 1, -HALF, HALF);
  // Crenellations along the top, for the silhouette against the sky.
  for (let x = -HALF; x <= HALF; x += 2) {
    if (Math.abs(x) < 2) continue;
    block(walls, 'Merlon', stone, [x, WALL_HEIGHT + 0.3, -HALF - 0.5], [0.9, 0.6, 1]);
    block(walls, 'Merlon', stone, [x, WALL_HEIGHT + 0.3, HALF + 0.5], [0.9, 0.6, 1]);
  }
  for (const side of [-1, 1]) block(walls, 'Gate Post', darkStone, [side * 2.1, 2.2, -HALF - 0.5], [1, 4.4, 1.6]);
  solid.add(walls);

  // The gate: iron bars that rise once every coin is taken. Not under Solid: the script lets the thief through.
  const bars = group('Gate Bars', [], [0, 1.5, -HALF - 0.5]);
  for (let i = 0; i < 7; i++) bars.add(meshObject('Bar', createCylinder(0.06, 3, 8), iron, [-1.35 + i * 0.45, 0, 0]));
  for (const y of [-1.2, 1.2]) bars.add(meshObject('Rail', cube, iron, [0, y, 0], [3.2, 0.12, 0.12]));
  scene.add(bars);

  // Hedges: rows the thief hides behind, with gaps to slip through.
  const hedges = group('Hedges');
  const hedgeRow = (x0: number, x1: number, z0: number, z1: number) =>
    block(hedges, 'Hedge', hedge, [(x0 + x1) / 2, 0.85, (z0 + z1) / 2], [x1 - x0, 1.7, z1 - z0]);
  hedgeRow(-15, -4, 9.5, 10.5);
  hedgeRow(4, 15, 9.5, 10.5);
  hedgeRow(-9, -2.5, 3.5, 4.5);
  hedgeRow(2.5, 9, 3.5, 4.5);
  hedgeRow(-16, -7, -10.5, -9.5);
  hedgeRow(-3, 3, -10.5, -9.5);
  hedgeRow(7, 11, -10.5, -9.5);
  hedgeRow(-10.5, -9.5, -8, -1);
  hedgeRow(4.5, 5.5, -16, -12);
  solid.add(hedges);

  // Statues on plinths: a robed figure each, turned a little differently.
  const statues = group('Statues');
  const statue = (name: string, x: number, z: number, turn: number) => {
    const s = group(name, [], [x, 0, z]);
    s.transform.setEulerDeg(0, turn, 0);
    s.add(meshObject('Plinth', cube, darkStone, [0, 0.5, 0], [1.4, 1, 1.4]));
    s.add(meshObject('Robe', createCylinder(0.42, 1.6, 20), marble, [0, 1.8, 0]));
    s.add(meshObject('Head', createSphere(0.27, 20, 12), marble, [0, 2.85, 0]));
    s.add(meshObject('Arm', createCylinder(0.11, 0.9, 10), marble, [0.42, 2.25, -0.2]));
    statues.add(s);
  };
  statue('Statue of the Founder', -6, -7, 20);
  statue('Statue of the Poet', 6, -7, -25);
  statue('Statue of the Queen', -14, 5, 60);
  statue('Statue of the Hunter', 14, 15, -70);
  solid.add(statues);

  // The pond: a stone rim around still, see-through water (an alpha-blended material, so it casts no shadow).
  const pond = group('Pond', [], [-14, 0, -3]);
  pond.add(meshObject('Pond Rim', createTorus(3, 0.25, 48, 10), darkStone, [0, 0.2, 0]));
  pond.add(meshObject('Pond Bed', createCylinder(3, 0.1, 48), new Material('Pond Bed', { baseColor: [0.05, 0.07, 0.05, 1], roughness: 1 }), [0, 0.02, 0]));
  const water = meshObject('Water', createCylinder(3, 0.04, 48), new Material('Water', {
    baseColor: [0.1, 0.25, 0.32, 0.55], metallic: 0.2, roughness: 0.05, blend: 'alpha',
  }), [0, 0.3, 0]);
  pond.add(water);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.4;
    const pad = meshObject('Lily Pad', createCylinder(0.35, 0.02, 16), new Material('Lily Pad', { baseColor: [0.1, 0.35, 0.08, 1], roughness: 0.6 }),
      [Math.cos(a) * 1.8, 0.33, Math.sin(a) * 1.6]);
    pad.castShadows = false;
    pond.add(pad);
  }
  solid.add(pond);

  // The chapel in the east, its door to the garden; stained glass on either side of it, lit from within.
  const chapel = group('Chapel', [], [15, 0, -2]);
  const cx0 = -3, cx1 = 3, cz0 = -4.5, cz1 = 4.5, ch = 4.2;
  const piece = (name: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, m = stone) =>
    block(chapel, name, m, [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], [x1 - x0, y1 - y0, z1 - z0]);
  // The west face (toward the garden): piers, the door, and two windows.
  const wx0 = cx0, wx1 = cx0 + 0.5;
  piece('Pier', wx0, wx1, 0, ch, cz0, -3.2);
  piece('Sill', wx0, wx1, 0, 1.2, -3.2, -1.6);
  piece('Lintel', wx0, wx1, 3.2, ch, -3.2, -1.6);
  piece('Pier', wx0, wx1, 0, ch, -1.6, -0.9);
  piece('Door Lintel', wx0, wx1, 2.6, ch, -0.9, 0.9);
  piece('Pier', wx0, wx1, 0, ch, 0.9, 1.6);
  piece('Sill', wx0, wx1, 0, 1.2, 1.6, 3.2);
  piece('Lintel', wx0, wx1, 3.2, ch, 1.6, 3.2);
  piece('Pier', wx0, wx1, 0, ch, 3.2, cz1);
  piece('North Side', cx0, cx1, 0, ch, cz0, cz0 + 0.5);
  piece('South Side', cx0, cx1, 0, ch, cz1 - 0.5, cz1);
  piece('Apse', cx1 - 0.5, cx1, 0, ch, cz0, cz1);
  piece('Roof', cx0 - 0.3, cx1 + 0.3, ch, ch + 0.4, cz0 - 0.3, cz1 + 0.3, roof);
  piece('Bell Tower', cx1 - 2, cx1, ch + 0.4, ch + 2.6, -1, 1, stone);
  piece('Altar', cx1 - 1.6, cx1 - 0.6, 0, 1, -0.8, 0.8, marble);
  // Stained glass: unlit (it glows with the candles behind it), half see-through.
  const glass = (name: string, color: Vec3, z0: number, z1: number) => {
    const pane = meshObject(name, createPlane(1), new Material(name, { baseColor: [...color, 0.6], unlit: true, doubleSided: true, blend: 'alpha' }),
      [wx0 + 0.25, 2.2, (z0 + z1) / 2], [2, 1, z1 - z0]);
    // Planes face +Y; stood up, facing the garden.
    pane.transform.setEulerDeg(0, 0, 90);
    chapel.add(pane);
  };
  glass('Ruby Glass', [0.9, 0.12, 0.1], -3.2, -1.6);
  glass('Sapphire Glass', [0.15, 0.3, 0.95], 1.6, 3.2);
  solid.add(chapel);
  // Candlelight from the altar, out through the door and the glass: a wide spot light whose shadows keep it inside
  // everywhere else (a point light would shine through the walls).
  const candleLight = new Light('spot', [1, 0.6, 0.3], 350);
  candleLight.innerAngle = 40;
  candleLight.outerAngle = 62;
  candleLight.castShadows = true;
  const candles = lightObject('Candlelight', candleLight, [17, 2.4, -2], 14);
  candles.transform.rotation = quat.lookRotation(vec3.normalize([-1, -0.3, 0]));
  candles.attachComponent(script('Flicker', { amount: 0.15, rate: 9 }));
  scene.add(candles);

  // The watchtowers and their lamps. A lamp's housing casts no shadow: it would swallow its own light.
  const towers = group('Towers');
  const lampGlass = new Material('Lamp Glass', { baseColor: [0, 0, 0, 1], emissive: [1, 0.8, 0.45], emissiveStrength: 3, unlit: true });
  const halo = new Material('Lamp Halo', { baseColor: [1, 0.65, 0.3, 0.18], unlit: true, blend: 'additive' });
  const tower = (name: string, x: number, z: number, aim: Vec3, sweep: number, period: number, phase: number) => {
    const t = group(name, [], [x, 0, z]);
    t.add(meshObject('Tower', createCylinder(1.3, 7, 16), stone, [0, 3.5, 0]));
    t.add(meshObject('Tower Top', createCylinder(1.6, 0.4, 16), darkStone, [0, 7.2, 0]));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      t.add(meshObject('Merlon', cube, darkStone, [Math.cos(a) * 1.35, 7.75, Math.sin(a) * 1.35], [0.5, 0.7, 0.5]));
    }
    // The lamp stands on a post, clear of the battlements: they'd catch its beam (and its shadow) otherwise.
    const post = meshObject('Lamp Post', createCylinder(0.1, 1.8, 8), iron, [0, 8.3, 0]);
    post.castShadows = false;
    t.add(post);
    solid.add(t);
    // Bright: they light lawn 15–20 m away, and the light falls off with the square of that.
    const lamp = new Light('spot', [1, 0.82, 0.55], 2500);
    lamp.innerAngle = 13;
    lamp.outerAngle = 19;
    lamp.castShadows = true;
    const pos: Vec3 = [x, 9.4, z];
    const lampObj = lightObject(`${name} Lamp`, lamp, pos, 32);
    const yaw = heading(pos, aim), tilt = 28;
    lampObj.attachComponent(script('Searchlight', { heading: yaw, sweep, tilt, period, phase }));
    // Aimed as the script starts it, so the beams show in the editor too.
    const y = ((yaw + sweep * Math.sin(phase * Math.PI * 2)) * Math.PI) / 180, down = (tilt * Math.PI) / 180;
    lampObj.transform.rotation = quat.lookRotation([Math.sin(y) * Math.cos(down), -Math.sin(down), -Math.cos(y) * Math.cos(down)]);
    // The housing points where the light does (along the lamp's −Z): a barrel with a glowing lens in front.
    const housing = meshObject('Housing', createCylinder(0.35, 0.8, 16), iron, [0, 0, 0.25]);
    housing.transform.setEulerDeg(90, 0, 0);
    housing.castShadows = false;
    lampObj.add(housing);
    const lens = meshObject('Lens', createCylinder(0.3, 0.05, 16), lampGlass, [0, 0, -0.17]);
    lens.transform.setEulerDeg(90, 0, 0);
    lens.castShadows = false;
    lampObj.add(lens);
    lampObj.add(meshObject('Halo', createSphere(0.9, 20, 12), halo, [0, 0, -0.3]));
    towers.add(lampObj);
  };
  tower('North-West Tower', -17, -17, [-4, 0, -4], 32, 8, 0);
  tower('North-East Tower', 17, -17, [6, 0, -6], 30, 6.5, 0.4);
  // Aimed north of the start, which stays out of its sweep.
  tower('South-East Tower', 17, 17, [9, 0, 1], 25, 7.5, 0.7);
  scene.add(towers);

  // The brazier in the middle of the garden: a point light with shadows, so everything around it throws one outward.
  const brazier = group('Brazier', [], [0, 0, -4]);
  brazier.add(meshObject('Brazier Stand', createCylinder(0.25, 1, 12), iron, [0, 0.5, 0]));
  brazier.add(meshObject('Brazier Bowl', createCylinder(0.7, 0.3, 20), iron, [0, 1.1, 0]));
  brazier.add(meshObject('Brazier Ring', createTorus(0.7, 0.06, 24, 8), gold, [0, 1.25, 0]));
  solid.add(brazier);
  const fire = lightObject('Brazier Fire', new Light('point', [1, 0.5, 0.18], 40), [0, 1.9, -4], 14);
  fire.light!.castShadows = true;
  fire.attachComponent(script('Flicker', { amount: 0.22, rate: 7 }));
  const flame = meshObject('Flame', createSphere(0.38, 16, 10), new Material('Flame', { baseColor: [1, 0.45, 0.1, 0.9], unlit: true, blend: 'additive' }), [0, -0.4, 0], [1, 1.5, 1]);
  fire.add(flame);
  fire.add(meshObject('Fire Glow', createSphere(0.9, 16, 10), new Material('Fire Glow', { baseColor: [1, 0.35, 0.08, 0.15], unlit: true, blend: 'additive' }), [0, -0.3, 0]));
  scene.add(fire);

  scene.add(solid);

  // Wall lanterns by the gate, without shadows: two more lights the sun has set for.
  for (const side of [-1, 1]) {
    const lantern = lightObject('Gate Lantern', new Light('point', [1, 0.7, 0.4], 12), [side * 2.1, 3.6, -HALF + 0.6], 7);
    lantern.add(meshObject('Lantern Glass', createSphere(0.16, 12, 8), lampGlass, [0, 0, 0]));
    lantern.children[0].castShadows = false;
    scene.add(lantern);
  }

  // The coins, where the lamps look most.
  const coins = group('Coins');
  const coinMesh = createCylinder(0.32, 0.07, 24);
  const coinSpots: Vec3[] = [[-17.5, 0.75, -1], [-12, 0.75, -14], [0, 0.75, -13], [14, 0.75, -13], [15, 0.75, -2], [-8, 0.75, 7]];
  coinSpots.forEach((p, i) => coins.add(meshObject(`Coin ${i + 1}`, coinMesh, gold, p)));
  scene.add(coins);

  // Fireflies over the lawns: tiny additive sparks.
  const fireflies = group('Fireflies');
  const spark = new Material('Firefly', { baseColor: [0.75, 1, 0.35, 0.9], unlit: true, blend: 'additive' });
  const sparkMesh = createSphere(0.06, 8, 6);
  for (let i = 0; i < 16; i++) {
    const p: Vec3 = [(random() - 0.5) * 34, 0.6 + random() * 1.4, (random() - 0.5) * 34];
    const f = meshObject(`Firefly ${i + 1}`, sparkMesh, spark, p);
    f.attachComponent(script('Firefly', { wander: 0.8 + random(), period: 6 + random() * 6, phase: random() }));
    fireflies.add(f);
  }
  scene.add(fireflies);

  // The thief: a hooded figure in a dark cloak.
  const cloak = new Material('Cloak', { baseColor: [0.16, 0.08, 0.2, 1], roughness: 0.85 });
  const thief = group('Thief', [], [0, 0, 15]);
  thief.add(meshObject('Cloak', createCylinder(0.32, 1.05, 16), cloak, [0, 0.55, 0]));
  thief.add(meshObject('Hood', createSphere(0.26, 16, 10), cloak, [0, 1.25, 0]));
  thief.add(meshObject('Face', createSphere(0.15, 12, 8), new Material('Shadowed Face', { baseColor: [0.02, 0.02, 0.02, 1] }), [0, 1.22, -0.14]));
  thief.add(meshObject('Sack', createSphere(0.2, 12, 8), wood, [0, 0.8, 0.3]));
  scene.add(thief);

  // HUD: the coin count, the alarm meter, messages and the controls.
  scene.add(hudText('Status', 'top-left', 22, -16, { text: 'Coins 0 / 6', fontSize: 26, bold: true, color: [1, 0.82, 0.4, 1], align: 'left', verticalAlign: 'top' }));
  const alarm = group('Alarm');
  alarm.add(hudText('Alarm Label', 'top-right', -150, -18, { text: 'ALARM', fontSize: 15, bold: true, color: [1, 0.9, 0.8, 0.9], verticalAlign: 'top' }));
  alarm.add(shapeObject('Alarm Frame', new Shape2D({ space: 'screen', anchor: 'top-right', width: 228, height: 16, cornerRadius: 8, fillColor: [0.05, 0.03, 0.04, 0.7], strokeWidth: 2, strokeColor: [1, 0.85, 0.7, 0.8] }), [-136, -52, 0]));
  // The fill grows from the left: its shape is offset inside an object the script scales along X.
  const fill = group('Alarm Fill', [], [-246, -52, 0]);
  fill.transform.scale = [0.001, 1, 1];
  fill.attachComponent(new Shape2D({ space: 'screen', anchor: 'top-right', shape: 'path', points: [0, -5, 220, -5, 220, 5, 0, 5], fillColor: [1, 0.75, 0.3, 1], order: 1 }));
  alarm.add(fill);
  scene.add(alarm);
  scene.add(hudText('Message', 'top', 0, -90, { text: '', fontSize: 30, bold: true, color: [1, 0.92, 0.75, 1], align: 'center', outlineWidth: 4, outlineColor: [0.1, 0.05, 0.1, 0.9] }));
  scene.add(hudText('Controls', 'bottom', 0, 12, { text: 'WASD / arrows: sneak   R: restart', fontSize: 14, color: [1, 1, 1, 0.85], verticalAlign: 'bottom' }));
  scene.add(group('Sounds', [
    soundObject('Coin Sound', 'coin'),
    soundObject('Caught Sound', 'hit'),
    soundObject('Gate Sound', 'thump'),
    soundObject('Win Sound', 'powerup'),
  ]));

  const camera = new GameObject('Camera');
  camera.camera = new CameraComponent({ fovDeg: 50, far: 400 });
  camera.transform.position = [0, 13, 22];
  camera.transform.lookAt([0, 0.8, 15]);
  camera.attachComponent(script('Follow'));
  scene.add(camera);

  // The setting sun, low in the west-south-west: long shadows across the lawns.
  const sun = new Light('directional', [1, 0.5, 0.25], 1.6);
  sun.castShadows = true;
  const sunObj = lightObject('Sun', sun, [-30, 12, 10]);
  sunObj.transform.rotation = quat.lookRotation(vec3.normalize([0.85, -0.32, -0.4]));
  scene.add(sunObj);
}
