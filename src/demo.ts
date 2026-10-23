import {
  CameraComponent,
  ColorCycle,
  GameObject,
  Light,
  LightPulse,
  Material,
  Orbiter,
  Rotator,
  Bobber,
  RigidBody,
  ScriptAsset,
  ScriptBehaviour,
  createCube,
  fitCollider,
  createCylinder,
  createPlane,
  createSphere,
  createTorus,
  quat,
  vec3,
  type BodyType,
  type Mesh,
  type Scene,
  type Vec3,
} from './engine';

// A TypeScript behaviour script, editable in the editor's Scripts tab.
const HOVER_SCRIPT = `import { Script, vec3, type Vec3 } from 'messier';

/** Floats the object along a figure-eight around where it starts. */
export default class Hover extends Script {
  /** Width of the loop in meters. */
  size = 0.8;
  /** Loops per second. */
  speed = 0.2;
  private home: Vec3 = [0, 0, 0];

  start(): void {
    this.home = vec3.clone(this.object.transform.position);
  }

  update(dt: number, time: number): void {
    const a = time * this.speed * Math.PI * 2;
    const offset: Vec3 = [Math.sin(a) * this.size, Math.sin(a * 2) * 0.15, Math.sin(a * 2) * this.size * 0.5];
    this.object.transform.position = vec3.add(this.home, offset);
  }
}
`;

function addBody(o: GameObject, type: BodyType, opts: ConstructorParameters<typeof RigidBody>[1] = {}): GameObject {
  o.rigidBody = new RigidBody(type);
  fitCollider(o.rigidBody, o.mesh);
  Object.assign(o.rigidBody, opts);
  return o;
}

function meshObject(name: string, mesh: Mesh, material: Material, position: Vec3): GameObject {
  const o = new GameObject(name);
  o.mesh = mesh;
  o.material = material;
  o.transform.position = position;
  return o;
}

function lightObject(name: string, light: Light, position: Vec3, eulerDeg?: Vec3): GameObject {
  const o = new GameObject(name);
  o.light = light;
  o.transform.position = position;
  if (eulerDeg) o.transform.setEulerDeg(...eulerDeg);
  return o;
}

/** Demo content showing PBR materials, shadows and animated dynamic lights. */
export function buildDemoScene(scene: Scene): void {
  const floorMat = new Material('Floor', { baseColor: [0.22, 0.23, 0.25, 1], roughness: 0.8 });
  const floor = meshObject('Floor', createPlane(30, 1), floorMat, [0, 0, 0]);
  scene.add(addBody(floor, 'static'));

  const cube = meshObject('Spinning Cube', createCube(1), new Material('Copper', { baseColor: [0.95, 0.64, 0.54, 1], metallic: 1, roughness: 0.3 }), [-2.5, 0.75, 0]);
  cube.transform.scale = [1.5, 1.5, 1.5];
  cube.behaviours.push(new Rotator({ speedX: 15, speedY: 40 }));
  scene.add(cube);

  const gold = meshObject('Gold Sphere', createSphere(0.6), new Material('Gold', { baseColor: [1, 0.77, 0.34, 1], metallic: 1, roughness: 0.2 }), [0, 0.6, -2]);
  gold.behaviours.push(new Bobber({ amplitude: 0.25, frequency: 0.4 }));
  scene.add(gold);

  scene.add(meshObject('Plastic Sphere', createSphere(0.6), new Material('Red Plastic', { baseColor: [0.8, 0.06, 0.05, 1], roughness: 0.35 }), [2.2, 0.6, -1]));

  const torus = meshObject('Torus', createTorus(0.7, 0.25), new Material('Teal', { baseColor: [0.05, 0.55, 0.5, 1], roughness: 0.45 }), [0.5, 1.4, 2]);
  torus.behaviours.push(new Rotator({ speedX: 30, speedY: 0, speedZ: 20 }));
  scene.add(torus);

  const pillarMat = new Material('Marble', { baseColor: [0.85, 0.84, 0.8, 1], roughness: 0.6 });
  const pillars = new GameObject('Pillars');
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const p = meshObject(`Pillar ${i + 1}`, createCylinder(0.3, 3), pillarMat, [Math.cos(a) * 6, 1.5, Math.sin(a) * 6]);
    pillars.add(addBody(p, 'static'));
  }
  scene.add(pillars);

  // Physics: in Play mode the ball drops onto the crate stack and knocks it over.
  const crateMat = new Material('Wood', { baseColor: [0.55, 0.36, 0.2, 1], roughness: 0.7 });
  const crates = new GameObject('Crates');
  for (let i = 0; i < 3; i++) {
    const c = meshObject(`Crate ${i + 1}`, createCube(0.8), crateMat, [4.2, 0.4 + i * 0.8, 0.6]);
    crates.add(addBody(c, 'dynamic', { mass: 2 }));
  }
  scene.add(crates);
  const ball = meshObject('Ball', createSphere(0.3), new Material('Rubber', { baseColor: [0.9, 0.85, 0.1, 1], roughness: 0.5 }), [3.95, 5, 0.75]);
  addBody(ball, 'dynamic', { shape: 'sphere', mass: 3, restitution: 0.5, angularDamping: 1.5 });
  scene.add(ball);

  const glow = meshObject('Glow Orb', createSphere(0.25), new Material('Emissive', { baseColor: [0.2, 0.6, 1, 1], emissive: [0.2, 0.6, 1], emissiveStrength: 4 }), [-1, 2.6, 2.5]);
  glow.castShadows = false;
  const hover = scene.scripts.add(new ScriptAsset('Hover', HOVER_SCRIPT));
  hover.compile();
  glow.behaviours.push(new ScriptBehaviour(hover));
  scene.add(glow);

  // Play renders through this camera.
  const camera = new GameObject('Main Camera');
  camera.camera = new CameraComponent({ fovDeg: 50 });
  camera.transform.position = [1.5, 4.5, 11];
  camera.transform.rotation = quat.lookRotation(vec3.sub([0.5, 1, 0], camera.transform.position));
  scene.add(camera);

  // Lights
  const sun = new Light('directional', [1, 0.95, 0.88], 1.6);
  sun.castShadows = true;
  scene.add(lightObject('Sun', sun, [4, 8, 4], [-55, 35, 0]));

  // Point lights parented to a spinning rig: moving/rotating the rig moves all of them.
  const rig = new GameObject('Light Rig');
  rig.behaviours.push(new Rotator({ speedY: 35 }));
  scene.add(rig);
  const colors: Vec3[] = [[1, 0.3, 0.2], [0.2, 0.5, 1], [0.3, 1, 0.4]];
  colors.forEach((c, i) => {
    const l = new Light('point', c, 18);
    l.range = 9;
    const a = (i / colors.length) * Math.PI * 2;
    const o = lightObject(`Point Light ${i + 1}`, l, [Math.cos(a) * 3.5, 1.3 + i * 0.3, Math.sin(a) * 3.5]);
    if (i === 0) o.behaviours.push(new LightPulse({ amount: 0.3, frequency: 1.5, flicker: 0.15 }));
    if (i === 1) o.behaviours.push(new Bobber({ amplitude: 0.6, frequency: 0.3 }));
    if (i === 2) o.behaviours.push(new ColorCycle({ speed: 0.08, saturation: 0.75 }));
    rig.add(o);
  });

  const wanderer = lightObject('Wandering Light', new Light('point', [1, 0.6, 1], 12), [2, 0.5, 4]);
  wanderer.behaviours.push(new Orbiter({ radius: 1.5, speed: 1.2 }));
  scene.add(wanderer);

  const spot = new Light('spot', [1, 0.9, 0.7], 60);
  spot.range = 14;
  spot.innerAngle = 14;
  spot.outerAngle = 24;
  const spotObj = lightObject('Spot Light', spot, [-4, 5, 4], [-50, -40, 0]);
  scene.add(spotObj);
}
