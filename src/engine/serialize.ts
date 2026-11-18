import { GameObject, type Scene } from './scene';
import { Material, MATERIAL_FIELDS, TEXTURE_SLOTS, type Texture } from './material';
import { Light, LIGHT_FIELDS, LIGHT_TYPE_INDEX } from './light';
import { CameraComponent, CAMERA_FIELDS, PROJECTIONS } from './camera';
import { BODY_TYPES, COLLIDER_SHAPES, RigidBody, RIGID_BODY_FIELDS } from './physics';
import { BEHAVIOURS, createBehaviour, type Behaviour } from './behaviours';
import { Script } from './scripting';
import { ANCHORS_2D, SHAPE2D_FIELDS, SHAPE_KINDS_2D, Shape2D, SPACES_2D, Text2D, TEXT2D_FIELDS } from './shapes2d';
import { TEXT_ALIGNS, TEXT_BASELINES } from './font';
import { AUDIO_SOURCE_FIELDS, AudioSource } from './audioSource';
import { Sky, SKY_FIELDS, SKY_MODES } from './sky';
import type { AudioClip, ClipRef } from './audioClip';
import type { Mesh, ResourceRef } from './mesh';
import { quat, type Quat, type Vec3 } from './math';
import { assignKnown, isObject, pickData, type Json } from './data';
import { SCENE_FORMAT, SCENE_VERSION, upgradeDocument } from './sceneFormat';
import {
  diffInstance, expandInstance, expandPrefab, isInstanceData, missingPrefab, newNodeId, prefabDependencies, prefabDocument, unscopedId,
  type NodeData, type PrefabData, type PrefabInstanceData, type PrefabLibrary,
} from './prefab';

// Scene <-> plain JSON data. Meshes and textures are saved as ResourceRefs
// (primitive generator args, or an index into an imported asset), and sound
// clips as ClipRefs (synthesizer parameters, or an imported sound file), never
// as vertex, pixel or sample data. Loading ignores unknown keys and keeps defaults for
// missing or mistyped values, so older and newer files load as far as they can. Older versions are upgraded first
// (sceneFormat.ts). Prefab instances are saved as links plus their changes (prefab.ts).

export { SCENE_FORMAT, SCENE_VERSION, PREFAB_FORMAT } from './sceneFormat';

const SCENE_SETTINGS = ['ambientColor', 'ambientIntensity', 'background', 'exposure', 'shadowExtent'] as const;
const MAX_DEPTH = 256;

export type BehaviourData =
  | { type: string; enabled: boolean; params: Record<string, number> }
  | { script: string; enabled: boolean; overrides: Record<string, number> };

export interface ObjectData {
  /** Set in prefabs: the object's id within the prefab. */
  id?: string;
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
  /** Shape2D fields plus `points` (flat x, y list). */
  shape2d?: Json;
  text2d?: Json;
  /** AudioSource fields plus `clip` (a ClipRef). */
  audioSource?: Json;
  behaviours?: BehaviourData[];
  children?: NodeData[];
}

export interface SceneData {
  format: typeof SCENE_FORMAT;
  version: number;
  /** Environment (ambient, background, exposure, shadow extent), `sky` (Sky fields plus `texture`, a ref) and `physics` ({ gravity, iterations }). */
  settings: Json;
  objects: NodeData[];
}

/** Turns refs back into meshes and textures while a scene loads. */
export interface SceneResources {
  /** Prefabs by asset id; without it, prefab instances load as empty placeholders (with a warning). */
  prefab?(id: string): PrefabData | null;
  mesh(ref: ResourceRef): Mesh | null;
  texture(ref: ResourceRef): Texture | null;
  /** Sound clips; without it, sources load without their clip (with a warning). */
  clip?(ref: ClipRef): AudioClip | null;
}

export function isClipRef(v: unknown): v is ClipRef {
  if (!isObject(v)) return false;
  if (Array.isArray(v.sfx)) return v.sfx.every((x) => typeof x === 'number' && Number.isFinite(x));
  return typeof v.asset === 'string' && Number.isInteger(v.index) && (v.index as number) >= 0;
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
  });
  // Base color textures first, then the other slots, so models saved before those were loaded keep their numbering.
  const tag = (t: Texture | null) => {
    if (t && !textures.has(t)) {
      t.ref = { asset, index: textures.size };
      textures.add(t);
    }
  };
  root.traverse((o) => tag(o.material?.baseColorTexture ?? null));
  root.traverse((o) => {
    for (const slot of TEXTURE_SLOTS) if (slot !== 'baseColorTexture') tag(o.material?.[slot] ?? null);
  });
  return { meshes: [...meshes], textures: [...textures] };
}

// --- Save ---------------------------------------------------------------------

interface SaveContext {
  warnings: string[];
  prefabs: PrefabLibrary | null;
  /** Set while writing a prefab: every object gets an id, unique in its scope. */
  ids: IdScope | null;
  /** Prefab expansions made during this save (diffing only reads them), so many instances share one. */
  expanded?: Map<string, Json | null>;
}

function expansion(id: string, ctx: SaveContext): Json | null {
  const cache = (ctx.expanded ??= new Map());
  if (!cache.has(id)) cache.set(id, expandPrefab(id, ctx.prefabs ?? NO_PREFABS, ctx.warnings));
  return cache.get(id)!;
}

/**
 * Ids of a prefab being written (or of an instance inside it). An object keeps the id it already has when that id
 * maps into this scope (see unscopedId) and is still free; otherwise it gets a new one. A new prefab ('' as
 * prefabRoot) gives every object a new id.
 */
interface IdScope {
  prefabRoot: string;
  rootId: string;
  used: Set<string>;
}

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const NO_PREFABS: PrefabLibrary = { prefab: () => null };

/** Snapshot of the scene as JSON-safe data. Problems (meshes built at runtime) are appended to `warnings`. */
export function serializeScene(scene: Scene, warnings: string[] = []): SceneData {
  const ctx: SaveContext = { warnings, prefabs: scene.prefabs, ids: null };
  return {
    format: SCENE_FORMAT,
    version: SCENE_VERSION,
    settings: {
      ...pickData(scene, SCENE_SETTINGS),
      sky: skyToData(scene.sky, warnings),
      physics: { gravity: [...scene.physics.gravity], iterations: scene.physics.iterations },
    },
    objects: scene.root.children.map((c) => objectToData(c, ctx)),
  };
}

/** One object with its descendants as saved in a scene; a prefab instance (needs `prefabs`) as its link and changes. */
export function serializeObject(obj: GameObject, prefabs: PrefabLibrary | null, warnings: string[] = []): NodeData {
  return objectToData(obj, { warnings, prefabs, ids: null });
}

const rootValues = (o: GameObject) => ({
  name: o.name,
  position: [...o.transform.position] as Vec3,
  rotation: [...o.transform.rotation] as Quat,
  scale: [...o.transform.scale] as Vec3,
});

function objectToData(o: GameObject, ctx: SaveContext): NodeData {
  const id = ctx.ids ? { id: pickId(o, ctx.ids) } : {};
  if (o._prefabStash) {
    // An instance whose prefab didn't load: kept as it was saved, with its current name and transform.
    const { prefab, id: _old, ...stash } = copy(o._prefabStash) as unknown as PrefabInstanceData;
    return { prefab, ...id, ...stash, ...rootValues(o) };
  }
  if (o.prefab) {
    const base = expansion(o.prefab, ctx);
    if (base) {
      const { prefab, ...rest } = instanceToData(o, o.prefab, o.prefabNode ?? (base.id as string), base, ctx);
      return { prefab, ...id, ...rest };
    }
    ctx.warnings.push(`${o.name}: its prefab is missing, so it's saved as plain objects`);
  }
  const d: ObjectData = { ...id, ...objectFields(o, ctx.warnings) };
  if (o.children.length) d.children = o.children.map((c) => objectToData(c, ctx));
  return d;
}

function pickId(o: GameObject, scope: IdScope): string {
  // A nested instance always gets an id of its own, so its objects' ids are prefixed and can't collide with others.
  let id = o.prefabNode !== null && o.prefab === null && scope.prefabRoot ? unscopedId(o.prefabNode, scope.prefabRoot, scope.rootId) : null;
  if (!id || id.includes('/') || scope.used.has(id)) {
    do id = newNodeId();
    while (scope.used.has(id));
  }
  scope.used.add(id);
  return id;
}

function allIds(tree: Json, out = new Set<string>()): Set<string> {
  if (typeof tree.id === 'string') out.add(tree.id);
  if (Array.isArray(tree.children)) for (const c of tree.children) if (isObject(c)) allIds(c, out);
  return out;
}

/**
 * Sorts `obj`'s children into objects of the instance (matched to `b`'s children by the id they're tagged with,
 * mapped from the scope whose root has id `rootId`) and objects added to it. Each prefab object matches one child at
 * most; a copy of one (a duplicate) counts as added.
 */
function matchChildren(
  obj: GameObject,
  b: Json,
  prefabRoot: string,
  rootId: string,
  member: (child: GameObject, node: Json) => void,
  added: (child: GameObject) => void,
): void {
  const nodes = Array.isArray(b.children) ? (b.children as Json[]) : [];
  const claimed = new Set<Json>();
  for (const c of obj.children) {
    const local = c.prefabNode !== null ? unscopedId(c.prefabNode, prefabRoot, rootId) : null;
    const match = local === null ? undefined : nodes.find((n) => n.id === local && !claimed.has(n));
    if (match) {
      claimed.add(match);
      member(c, match);
    } else {
      added(c);
    }
  }
}

/**
 * An instance root (`o`) as its prefab's id, its own name and transform, and how its objects differ from `base`
 * (the prefab's expansion). `rootId` is the id `o`'s objects are tagged under: `o.prefabNode` for an instance nested
 * in another one, else the prefab root's id.
 */
function instanceToData(o: GameObject, prefab: string, rootId: string, base: Json, ctx: SaveContext): PrefabInstanceData {
  const prefabRoot = base.id as string;
  const added = new Set<Json>();
  // In a prefab, objects added to a nested instance get ids of that instance's own prefab.
  const inner: SaveContext = ctx.ids ? { ...ctx, ids: { prefabRoot, rootId, used: allIds(base) } } : ctx;
  const capture = (obj: GameObject, b: Json): Json => {
    const d: Json = { id: b.id, ...objectFields(obj, ctx.warnings) };
    const children: Json[] = [];
    matchChildren(obj, b, prefabRoot, rootId, (c, n) => children.push(capture(c, n)), (c) => {
      const x = objectToData(c, inner) as unknown as Json;
      added.add(x);
      children.push(x);
    });
    if (children.length) d.children = children;
    return d;
  };
  return { prefab, ...rootValues(o), ...diffInstance(capture(o, base), base, added) };
}

/**
 * A prefab made of `obj` and its descendants. Instances among them become nested instances, and an instance root
 * makes a variant of its prefab. With `applyTo` (the prefab `obj` is an instance of), it's that prefab's new
 * version instead, `obj`'s changes included: its objects keep their ids, so other instances' overrides still find
 * them. Throws when the prefab would contain itself.
 */
export function prefabFromObject(obj: GameObject, prefabs: PrefabLibrary | null, warnings: string[] = [], applyTo?: string): PrefabData {
  const lib = prefabs ?? NO_PREFABS;
  if (!applyTo) return prefabDocument(objectToData(obj, { warnings, prefabs, ids: { prefabRoot: '', rootId: '', used: new Set() } }));
  const base = expandPrefab(applyTo, lib, warnings);
  if (!base) throw new Error('The prefab is missing');
  const scope: IdScope = { prefabRoot: base.id as string, rootId: obj.prefabNode ?? (base.id as string), used: allIds(base) };
  const root = toPrefabNode(obj, base, scope, { warnings, prefabs, ids: scope });
  if (prefabDependencies(root, lib).has(applyTo)) throw new Error("A prefab can't contain an instance of itself");
  return prefabDocument(root);
}

/** An object of the prefab being written (`b`, in its expansion) as the prefab file saves it. */
function toPrefabNode(obj: GameObject, b: Json, scope: IdScope, ctx: SaveContext): NodeData {
  const id = b.id as string;
  if (isInstanceData(b.missingPrefab)) return { ...copy(b.missingPrefab), id, ...rootValues(obj) };
  if (typeof b.instanceOf === 'string') {
    // A nested instance (or the root of a variant): saved as an instance of its own prefab.
    const inner = expansion(b.instanceOf, ctx);
    if (inner) {
      const { prefab, ...rest } = instanceToData(obj, b.instanceOf, obj.prefabNode ?? scope.rootId, inner, ctx);
      return { prefab, id, ...rest };
    }
  }
  const d: ObjectData = { id, ...objectFields(obj, ctx.warnings) };
  const children: NodeData[] = [];
  matchChildren(obj, b, scope.prefabRoot, scope.rootId, (c, n) => children.push(toPrefabNode(c, n, scope, ctx)), (c) => children.push(objectToData(c, ctx)));
  if (children.length) d.children = children;
  return d;
}

/**
 * Turns an instance back into plain objects: its objects forget the prefab, while instances nested in it stay
 * instances (and a variant becomes an instance of the prefab it's based on). Returns a function that undoes it.
 */
export function unpackInstance(obj: GameObject, prefabs: PrefabLibrary | null): () => void {
  const saved: [GameObject, string | null, string | null, Json | null][] = [];
  const set = (o: GameObject, prefab: string | null, node: string | null) => {
    saved.push([o, o.prefab, o.prefabNode, o._prefabStash]);
    o.prefab = prefab;
    o.prefabNode = node;
    o._prefabStash = null;
  };
  const base = obj.prefab && !obj._prefabStash ? expandPrefab(obj.prefab, prefabs ?? NO_PREFABS) : null;
  if (!base) set(obj, null, null);
  else {
    const prefabRoot = base.id as string;
    const rootId = obj.prefabNode ?? prefabRoot;
    const walk = (o: GameObject, b: Json) => {
      if (typeof b.instanceOf === 'string' && o === obj) return set(o, b.instanceOf, o.prefabNode ?? rootId);
      if (typeof b.instanceOf === 'string' || b.missingPrefab) return;
      set(o, null, null);
      matchChildren(o, b, prefabRoot, rootId, walk, () => undefined);
    };
    walk(obj, base);
  }
  return () => {
    for (const [o, prefab, node, stash] of saved.reverse()) {
      o.prefab = prefab;
      o.prefabNode = node;
      o._prefabStash = stash;
    }
  };
}

/** An object's own data: name, transform, flags and components, without children. */
function objectFields(o: GameObject, warnings: string[]): ObjectData {
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
    for (const slot of TEXTURE_SLOTS) {
      const tex = o.material[slot];
      if (tex?.ref) d.material[slot] = copyRef(tex.ref);
      else if (tex) warnings.push(`${o.name}: texture "${tex.name}" was created at runtime and can't be saved`);
    }
  }
  if (o.light) d.light = pickData(o.light, LIGHT_FIELDS);
  if (o.camera) d.camera = pickData(o.camera, CAMERA_FIELDS);
  if (o.rigidBody) d.rigidBody = pickData(o.rigidBody, RIGID_BODY_FIELDS);
  const shape = o.getComponent(Shape2D);
  if (shape) {
    d.shape2d = pickData(shape, SHAPE2D_FIELDS);
    if (shape.points.length > 1) d.shape2d.points = shape.points.slice(0, shape.points.length & ~1);
  }
  const text = o.getComponent(Text2D);
  if (text) d.text2d = pickData(text, TEXT2D_FIELDS);
  const source = o.getComponent(AudioSource);
  if (source) {
    d.audioSource = pickData(source, AUDIO_SOURCE_FIELDS);
    const ref = source.clip?.ref;
    if (ref) d.audioSource.clip = 'sfx' in ref ? { sfx: [...ref.sfx] } : { asset: ref.asset, index: ref.index };
    else if (source.clip) warnings.push(`${o.name}: sound "${source.clip.name}" was created at runtime and can't be saved`);
  }
  if (o.behaviours.length) d.behaviours = o.behaviours.map(behaviourToData);
  return d;
}

function behaviourToData(b: Behaviour): BehaviourData {
  if (b instanceof Script && b.asset) return { script: b.asset.name, enabled: b.enabled, overrides: { ...b.overrides } };
  return { type: b.typeName, enabled: b.enabled, params: { ...b.params } };
}

function skyToData(sky: Sky, warnings: string[]): Json {
  const d = pickData(sky, SKY_FIELDS);
  if (sky.texture?.ref) d.texture = copyRef(sky.texture.ref);
  else if (sky.texture) warnings.push(`Sky: image "${sky.texture.name}" was created at runtime and can't be saved`);
  return d;
}

// --- Load ---------------------------------------------------------------------

/** `data` as a scene of the current version (upgraded if it's older). Throws unless it's a scene this version can read. */
export function upgradeSceneData(data: unknown): SceneData {
  return upgradeDocument(data, SCENE_FORMAT, 'scene') as unknown as SceneData;
}

/**
 * Replaces the scene's objects and settings with `data`. Scripts are looked up
 * by name in `scene.scripts`, so load the project's scripts first. Missing
 * resources, prefabs, scripts and behaviour types are skipped and reported in `warnings`.
 */
export function applySceneData(scene: Scene, data: unknown, resources: SceneResources, warnings: string[] = []): void {
  const doc = upgradeSceneData(data);
  for (const c of [...scene.root.children]) scene.root.remove(c);
  const settings = isObject(doc.settings) ? doc.settings : {};
  assignKnown(scene, settings, SCENE_SETTINGS);
  // Scenes saved before skies existed get the default (the flat background), not the previous scene's sky.
  const sky = assignKnown(scene.sky.copyFrom(new Sky()), settings.sky, SKY_FIELDS);
  if (!SKY_MODES.includes(sky.mode)) sky.mode = 'color';
  const skyTexture = isObject(settings.sky) ? settings.sky.texture : undefined;
  if (skyTexture !== undefined) {
    sky.texture = isResourceRef(skyTexture) ? resources.texture(skyTexture) : null;
    if (!sky.texture) warnings.push('Sky: image not found');
  }
  assignKnown(scene.physics, settings.physics, ['gravity', 'iterations']);
  scene.physics.iterations = Math.max(1, Math.round(scene.physics.iterations));
  const objects = Array.isArray(doc.objects) ? doc.objects : [];
  for (const d of objects) if (isObject(d)) scene.add(dataToObject(d, scene, resources, warnings, 0));
  scene.updateMatrices();
}

/** A detached object built from saved data of the current version (see serializeObject). */
export function deserializeObject(data: NodeData, scene: Scene, resources: SceneResources, warnings: string[] = []): GameObject {
  return dataToObject(data as unknown as Json, scene, resources, warnings, 0);
}

/** A new, detached instance of prefab `id` as the prefab has it (its root's name and transform); null when it's missing. */
export function instantiatePrefab(id: string, scene: Scene, resources: SceneResources, warnings: string[] = []): GameObject | null {
  const p = resources.prefab?.(id);
  if (!p) return null;
  const r = p.root as unknown as Json;
  return dataToObject({ prefab: id, name: r.name, position: r.position, rotation: r.rotation, scale: r.scale }, scene, resources, warnings, 0);
}

function dataToObject(d: Json, scene: Scene, res: SceneResources, warnings: string[], depth: number): GameObject {
  if (depth > MAX_DEPTH) throw new Error('Scene hierarchy too deep');
  if (isInstanceData(d)) {
    const lib: PrefabLibrary = res.prefab ? { prefab: (id) => res.prefab!(id) } : NO_PREFABS;
    d = expandInstance(d, lib, warnings) ?? missingPrefab(d, warnings);
  }
  const o = new GameObject(typeof d.name === 'string' ? d.name : 'GameObject');
  assignKnown(o.transform, d, ['position', 'rotation', 'scale']);
  const r = o.transform.rotation;
  // Only fix rotations that aren't unit length, so saving again gives identical numbers.
  if (Math.abs(Math.hypot(...r) - 1) > 1e-6) o.transform.rotation = Math.hypot(...r) > 0 ? quat.normalize(r) : quat.identity();
  assignKnown(o, d, ['visible', 'castShadows']);
  if (typeof d.id === 'string') o.prefabNode = d.id;
  if (typeof d.instanceOf === 'string') o.prefab = d.instanceOf;
  if (isInstanceData(d.missingPrefab)) {
    o.prefab = d.missingPrefab.prefab;
    o._prefabStash = copy(d.missingPrefab) as unknown as Json;
  }

  if (d.mesh !== undefined) {
    o.mesh = isResourceRef(d.mesh) ? res.mesh(d.mesh) : null;
    if (!o.mesh) warnings.push(`${o.name}: mesh not found`);
  }
  if (isObject(d.material)) {
    const m = assignKnown(new Material(), d.material, MATERIAL_FIELDS);
    for (const slot of TEXTURE_SLOTS) {
      const ref = d.material[slot];
      if (ref === undefined) continue;
      m[slot] = isResourceRef(ref) ? res.texture(ref) : null;
      if (!m[slot]) warnings.push(`${o.name}: texture not found`);
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
  if (isObject(d.shape2d)) {
    const sh = assignKnown(new Shape2D(), d.shape2d, SHAPE2D_FIELDS);
    const pts = d.shape2d.points;
    if (Array.isArray(pts) && pts.every((x) => typeof x === 'number' && Number.isFinite(x))) sh.points = pts.slice(0, pts.length & ~1) as number[];
    if (!SHAPE_KINDS_2D.includes(sh.shape)) sh.shape = 'rectangle';
    fix2D(sh);
    o.attachComponent(sh);
  }
  if (isObject(d.text2d)) {
    const t = assignKnown(new Text2D(), d.text2d, TEXT2D_FIELDS);
    if (!TEXT_ALIGNS.includes(t.align)) t.align = 'center';
    if (!TEXT_BASELINES.includes(t.verticalAlign)) t.verticalAlign = 'middle';
    fix2D(t);
    o.attachComponent(t);
  }
  if (isObject(d.audioSource)) {
    const src = assignKnown(new AudioSource(), d.audioSource, AUDIO_SOURCE_FIELDS);
    if (d.audioSource.clip !== undefined) {
      src.clip = isClipRef(d.audioSource.clip) ? (res.clip?.(d.audioSource.clip) ?? null) : null;
      if (!src.clip) warnings.push(`${o.name}: sound not found`);
    }
    o.attachComponent(src);
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

function fix2D(r: Shape2D | Text2D): void {
  if (!SPACES_2D.includes(r.space)) r.space = 'world';
  if (!ANCHORS_2D.includes(r.anchor)) r.anchor = 'center';
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

/** Asset ids a scene uses itself: its objects' (see collectAssetIds) and its sky image's. Project.usedAssetIds adds what its prefabs use. */
export function sceneAssetIds(data: SceneData, out = new Set<string>()): Set<string> {
  collectAssetIds(data.objects, out);
  collectAssetIds(data.settings, out);
  return out;
}

/** Asset ids anywhere in saved data: refs of meshes, textures and sounds, and prefabs that instances link to. */
export function collectAssetIds(data: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(data)) {
    for (const x of data) collectAssetIds(x, out);
  } else if (isObject(data)) {
    if (typeof data.prefab === 'string') out.add(data.prefab);
    if ((isResourceRef(data) || isClipRef(data)) && 'asset' in data) out.add(data.asset);
    for (const v of Object.values(data)) if (typeof v === 'object' && v !== null) collectAssetIds(v, out);
  }
  return out;
}
