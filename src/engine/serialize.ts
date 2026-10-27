import { GameObject, type Scene } from './scene';
import { Material, MATERIAL_FIELDS, type Texture } from './material';
import { Light, LIGHT_FIELDS, LIGHT_TYPE_INDEX } from './light';
import { CameraComponent, CAMERA_FIELDS, PROJECTIONS } from './camera';
import { BODY_TYPES, COLLIDER_SHAPES, RigidBody, RIGID_BODY_FIELDS } from './physics';
import { BEHAVIOURS, createBehaviour, type Behaviour } from './behaviours';
import { Script } from './scripting';
import type { Mesh, ResourceRef } from './mesh';
import { quat, type Quat, type Vec3 } from './math';
import { assignKnown, isObject, pickData, type Json } from './data';

// Scene <-> plain JSON data. Meshes and textures are saved as ResourceRefs
// (primitive generator args, or an index into an imported asset), never as
// vertex or pixel data. Loading ignores unknown keys and keeps defaults for
// missing or mistyped values, so older and newer files load as far as they can.

export const SCENE_FORMAT = 'messier-scene';
export const SCENE_VERSION = 1;

const SCENE_SETTINGS = ['ambientColor', 'ambientIntensity', 'background', 'exposure', 'shadowExtent'] as const;
const MAX_DEPTH = 256;

export type BehaviourData =
  | { type: string; enabled: boolean; params: Record<string, number> }
  | { script: string; enabled: boolean; overrides: Record<string, number> };

export interface ObjectData {
  name: string;
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
  visible: boolean;
  castShadows: boolean;
  mesh?: ResourceRef;
  /** Material fields plus `texture` (a ref). */
  material?: Json;
  light?: Json;
  camera?: Json;
  rigidBody?: Json;
  behaviours?: BehaviourData[];
  children?: ObjectData[];
}

export interface SceneData {
  format: typeof SCENE_FORMAT;
  version: number;
  /** Environment (ambient, background, exposure, shadow extent) and `physics` ({ gravity, iterations }). */
  settings: Json;
  objects: ObjectData[];
}

/** Turns refs back into meshes and textures while a scene loads. */
export interface SceneResources {
  mesh(ref: ResourceRef): Mesh | null;
  texture(ref: ResourceRef): Texture | null;
}

export function isResourceRef(v: unknown): v is ResourceRef {
  if (!isObject(v)) return false;
  if (typeof v.primitive === 'string') return Array.isArray(v.args) && v.args.every((a) => typeof a === 'number');
  return typeof v.asset === 'string' && Number.isInteger(v.index) && (v.index as number) >= 0;
}

const copyRef = (r: ResourceRef): ResourceRef => ('primitive' in r ? { primitive: r.primitive, args: [...r.args] } : { asset: r.asset, index: r.index });

/**
 * Stamps `{ asset, index }` refs on the meshes and textures of a freshly loaded
 * model, numbered in hierarchy order. Loaders are deterministic, so loading the
 * same files again and tagging them gives the same numbering.
 */
export function tagAssetResources(root: GameObject, asset: string): { meshes: Mesh[]; textures: Texture[] } {
  const meshes = new Set<Mesh>();
  const textures = new Set<Texture>();
  root.traverse((o) => {
    if (o.mesh && !meshes.has(o.mesh)) {
      o.mesh.ref = { asset, index: meshes.size };
      meshes.add(o.mesh);
    }
    const t = o.material?.baseColorTexture;
    if (t && !textures.has(t)) {
      t.ref = { asset, index: textures.size };
      textures.add(t);
    }
  });
  return { meshes: [...meshes], textures: [...textures] };
}

// --- Save ---------------------------------------------------------------------

/** Snapshot of the scene as JSON-safe data. Problems (meshes built at runtime) are appended to `warnings`. */
export function serializeScene(scene: Scene, warnings: string[] = []): SceneData {
  return {
    format: SCENE_FORMAT,
    version: SCENE_VERSION,
    settings: { ...pickData(scene, SCENE_SETTINGS), physics: { gravity: [...scene.physics.gravity], iterations: scene.physics.iterations } },
    objects: scene.root.children.map((c) => objectToData(c, warnings)),
  };
}

function objectToData(o: GameObject, warnings: string[]): ObjectData {
  const t = o.transform;
  const d: ObjectData = {
    name: o.name,
    position: [...t.position],
    rotation: [...t.rotation],
    scale: [...t.scale],
    visible: o.visible,
    castShadows: o.castShadows,
  };
  if (o.mesh) {
    if (o.mesh.ref) d.mesh = copyRef(o.mesh.ref);
    else warnings.push(`${o.name}: mesh "${o.mesh.name}" was created at runtime and can't be saved`);
  }
  if (o.material) {
    d.material = pickData(o.material, MATERIAL_FIELDS);
    const tex = o.material.baseColorTexture;
    if (tex?.ref) d.material.texture = copyRef(tex.ref);
    else if (tex) warnings.push(`${o.name}: texture "${tex.name}" was created at runtime and can't be saved`);
  }
  if (o.light) d.light = pickData(o.light, LIGHT_FIELDS);
  if (o.camera) d.camera = pickData(o.camera, CAMERA_FIELDS);
  if (o.rigidBody) d.rigidBody = pickData(o.rigidBody, RIGID_BODY_FIELDS);
  if (o.behaviours.length) d.behaviours = o.behaviours.map(behaviourToData);
  if (o.children.length) d.children = o.children.map((c) => objectToData(c, warnings));
  return d;
}

function behaviourToData(b: Behaviour): BehaviourData {
  if (b instanceof Script && b.asset) return { script: b.asset.name, enabled: b.enabled, overrides: { ...b.overrides } };
  return { type: b.typeName, enabled: b.enabled, params: { ...b.params } };
}

// --- Load ---------------------------------------------------------------------

/** Throws unless `data` looks like a scene this version can read. */
export function checkSceneData(data: unknown): asserts data is SceneData {
  if (!isObject(data) || data.format !== SCENE_FORMAT) throw new Error('Not a Messier scene');
  const v = data.version;
  if (typeof v !== 'number') throw new Error('Scene has no version');
  if (v > SCENE_VERSION) throw new Error(`Scene was saved by a newer Messier (scene format ${v}; this version reads up to ${SCENE_VERSION})`);
}

/**
 * Replaces the scene's objects and settings with `data`. Scripts are looked up
 * by name in `scene.scripts`, so load the project's scripts first. Missing
 * resources, scripts and behaviour types are skipped and reported in `warnings`.
 */
export function applySceneData(scene: Scene, data: unknown, resources: SceneResources, warnings: string[] = []): void {
  checkSceneData(data);
  for (const c of [...scene.root.children]) scene.root.remove(c);
  const settings = isObject(data.settings) ? data.settings : {};
  assignKnown(scene, settings, SCENE_SETTINGS);
  assignKnown(scene.physics, settings.physics, ['gravity', 'iterations']);
  scene.physics.iterations = Math.max(1, Math.round(scene.physics.iterations));
  const objects = Array.isArray(data.objects) ? data.objects : [];
  for (const d of objects) if (isObject(d)) scene.add(dataToObject(d, scene, resources, warnings, 0));
  scene.updateMatrices();
}

function dataToObject(d: Json, scene: Scene, res: SceneResources, warnings: string[], depth: number): GameObject {
  if (depth > MAX_DEPTH) throw new Error('Scene hierarchy too deep');
  const o = new GameObject(typeof d.name === 'string' ? d.name : 'GameObject');
  assignKnown(o.transform, d, ['position', 'rotation', 'scale']);
  const r = o.transform.rotation;
  // Only fix rotations that aren't unit length, so saving again gives identical numbers.
  if (Math.abs(Math.hypot(...r) - 1) > 1e-6) o.transform.rotation = Math.hypot(...r) > 0 ? quat.normalize(r) : quat.identity();
  assignKnown(o, d, ['visible', 'castShadows']);

  if (d.mesh !== undefined) {
    o.mesh = isResourceRef(d.mesh) ? res.mesh(d.mesh) : null;
    if (!o.mesh) warnings.push(`${o.name}: mesh not found`);
  }
  if (isObject(d.material)) {
    const m = assignKnown(new Material(), d.material, MATERIAL_FIELDS);
    if (d.material.texture !== undefined) {
      m.baseColorTexture = isResourceRef(d.material.texture) ? res.texture(d.material.texture) : null;
      if (!m.baseColorTexture) warnings.push(`${o.name}: texture not found`);
    }
    o.material = m;
  }
  if (isObject(d.light)) {
    const l = assignKnown(new Light(), d.light, LIGHT_FIELDS);
    if (!(l.type in LIGHT_TYPE_INDEX)) l.type = 'point';
    o.light = l;
  }
  if (isObject(d.camera)) {
    const c = assignKnown(new CameraComponent(), d.camera, CAMERA_FIELDS);
    if (!PROJECTIONS.includes(c.projection)) c.projection = 'perspective';
    o.camera = c;
  }
  if (isObject(d.rigidBody)) {
    const rb = assignKnown(new RigidBody(), d.rigidBody, RIGID_BODY_FIELDS);
    if (!BODY_TYPES.includes(rb.type)) rb.type = 'dynamic';
    if (!COLLIDER_SHAPES.includes(rb.shape)) rb.shape = 'box';
    o.rigidBody = rb;
  }
  if (Array.isArray(d.behaviours)) {
    for (const bd of d.behaviours) {
      const b = isObject(bd) ? dataToBehaviour(bd, scene, o.name, warnings) : null;
      if (b) o.attachComponent(b);
    }
  }
  if (Array.isArray(d.children)) {
    for (const c of d.children) if (isObject(c)) o.add(dataToObject(c, scene, res, warnings, depth + 1));
  }
  return o;
}

function numbers(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (isObject(v)) for (const [k, x] of Object.entries(v)) if (typeof x === 'number' && Number.isFinite(x)) out[k] = x;
  return out;
}

function dataToBehaviour(d: Json, scene: Scene, owner: string, warnings: string[]): Behaviour | null {
  let b: Behaviour;
  if (typeof d.script === 'string') {
    const asset = scene.scripts.get(d.script);
    if (!asset) {
      warnings.push(`${owner}: script "${d.script}" not found`);
      return null;
    }
    b = asset.create(numbers(d.overrides));
  } else if (typeof d.type === 'string' && d.type in BEHAVIOURS) {
    b = createBehaviour(d.type);
    for (const [k, v] of Object.entries(numbers(d.params))) if (k in b.params) b.params[k] = v;
  } else {
    warnings.push(`${owner}: unknown behaviour "${String(d.type)}"`);
    return null;
  }
  if (typeof d.enabled === 'boolean') b.enabled = d.enabled;
  return b;
}

/** Asset ids referenced by meshes and textures in `objects` (recursively). */
export function collectAssetIds(objects: unknown, out = new Set<string>()): Set<string> {
  if (!Array.isArray(objects)) return out;
  for (const d of objects) {
    if (!isObject(d)) continue;
    if (isResourceRef(d.mesh) && 'asset' in d.mesh) out.add(d.mesh.asset);
    const tex = isObject(d.material) ? d.material.texture : undefined;
    if (isResourceRef(tex) && 'asset' in tex) out.add(tex.asset);
    collectAssetIds(d.children, out);
  }
  return out;
}
