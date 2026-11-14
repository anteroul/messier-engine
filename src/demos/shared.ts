import {
  GameObject,
  Material,
  RigidBody,
  ScriptAsset,
  Shape2D,
  Text2D,
  fitCollider,
  type BodyType,
  type Light,
  type Mesh,
  type Scene,
  type Script,
  type Vec3,
  type Vec4,
} from '../engine';

// Helpers the showcase games' scene builders share. The games' rules are TypeScript scripts (source strings, like
// anything written in the Scripts tab); the builders only lay out objects, so each scene saves like a hand-made one.

export type ScriptList = readonly (readonly [name: string, source: string])[];

/** Name of the menu scene the games return to. */
export const ARCADE_SCENE = 'Arcade';

const ARCADE_LINK_SCRIPT = `import { Script, input, sceneManager } from 'messier';

/** Backspace goes back to the menu scene, when the build (or the project being played) has one. */
export default class ArcadeLink extends Script {
  update(): void {
    if (!input.pressed('Backspace')) return;
    for (let i = 0; i < sceneManager.sceneCount; i++) {
      if (sceneManager.sceneName(i) === '${ARCADE_SCENE}') void sceneManager.loadScene(i);
    }
  }
}
`;

export const SHARED_SCRIPTS: ScriptList = [['ArcadeLink', ARCADE_LINK_SCRIPT]];

/** Adds the scripts to the scene's library (compiled) unless they're there already. Returns an instance factory. */
export function addScripts(scene: Scene, list: ScriptList): (name: string, overrides?: Record<string, number>) => Script {
  const lib = scene.scripts;
  for (const [name, source] of list) {
    const asset = lib.get(name) ?? lib.add(new ScriptAsset(name, source));
    if (asset.compiledSource !== asset.source) asset.compile();
  }
  return (name, overrides) => lib.get(name)!.create(overrides);
}

export function meshObject(name: string, mesh: Mesh, material: Material, position: Vec3, scale?: Vec3): GameObject {
  const o = new GameObject(name);
  o.mesh = mesh;
  o.material = material;
  o.transform.position = position;
  if (scale) o.transform.scale = scale;
  return o;
}

export function withBody(o: GameObject, type: BodyType, opts: ConstructorParameters<typeof RigidBody>[1] = {}): GameObject {
  o.rigidBody = new RigidBody(type);
  fitCollider(o.rigidBody, o.mesh);
  Object.assign(o.rigidBody, opts);
  return o;
}

export function group(name: string, children: GameObject[] = [], position: Vec3 = [0, 0, 0]): GameObject {
  const o = new GameObject(name);
  o.transform.position = position;
  for (const c of children) o.add(c);
  return o;
}

/** A material that shows `color` as is (times `strength`), whatever the lighting: neon tubes, screens, stars. */
export function neon(name: string, color: Vec3, strength = 1): Material {
  return new Material(name, { baseColor: [0, 0, 0, 1], emissive: color, emissiveStrength: strength, unlit: true });
}

export function lightObject(name: string, light: Light, position: Vec3, range?: number): GameObject {
  const o = new GameObject(name);
  if (range !== undefined) light.range = range;
  o.light = light;
  o.transform.position = position;
  return o;
}

export function shapeObject(name: string, shape: Shape2D, position: Vec3 = [0, 0, 0]): GameObject {
  const o = new GameObject(name);
  o.attachComponent(shape);
  o.transform.position = position;
  return o;
}

/**
 * A soft glow: a few translucent discs of growing size on the object's XY plane (facing +Z). The engine has no bloom,
 * so this is how lamps, engines and suns get their halo.
 */
export function glow(name: string, color: Vec3, size: number, alpha = 0.16, order = 0, layers = 4): GameObject {
  const o = new GameObject(name);
  for (let i = 0; i < layers; i++) {
    const d = size * ((i + 1) / layers) ** 1.5;
    o.add(shapeObject(`${name} ${i + 1}`, new Shape2D({ shape: 'ellipse', width: d, height: d, fillColor: [...color, alpha] as Vec4, order })));
  }
  return o;
}

type TextInit = NonNullable<ConstructorParameters<typeof Text2D>[0]>;

/** Screen-space text at `anchor`, offset by (x, y) pixels (+Y up). */
export function hudText(name: string, anchor: TextInit['anchor'], x: number, y: number, init: TextInit): GameObject {
  const o = new GameObject(name);
  o.attachComponent(new Text2D({ space: 'screen', anchor, outlineWidth: 2, outlineColor: [0, 0, 0, 0.7], ...init }));
  o.transform.position = [x, y, 0];
  return o;
}

/** Small deterministic random generator, so a builder lays out the same scene every time. */
export function seeded(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}
