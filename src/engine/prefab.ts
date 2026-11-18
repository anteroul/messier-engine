import { isObject, type Json } from './data';
import { PREFAB_FORMAT, SCENE_VERSION, upgradeDocument } from './sceneFormat';
import type { ObjectData } from './serialize';
import type { Quat, Vec3 } from './math';

// Prefabs: an object hierarchy saved as an asset (assets/**/*.prefab), placed in scenes as instances.
//
// A prefab file holds one object tree in which every object has an `id`, unique within the prefab. A scene (or another
// prefab) stores an instance as a link: the prefab's asset id, the instance root's own name and transform, and what
// the instance changes, keyed by those ids: field overrides, removed objects and added objects. Loading *expands* an
// instance: a copy of the prefab's objects with the changes applied, each object tagged with its id
// (GameObject.prefabNode). Saving compares the live objects with a fresh expansion and keeps only the differences,
// so edits to a prefab reach every instance except where an instance overrides them.
//
// A prefab can contain instances of other prefabs (and its root can be one: a variant). Expanding nests them, and the
// ids of a nested instance's objects become paths: `<nested instance's id>/<id within its prefab>`, the nested root
// itself taking the instance's id. So ids stay unique when a prefab holds the same prefab twice, and an instance's
// overrides can reach into the instances nested in it.

export const PREFAB_EXTENSION = '.prefab';

export const isPrefabFile = (name: string) => name.toLowerCase().endsWith(PREFAB_EXTENSION);

export interface PrefabData {
  format: typeof PREFAB_FORMAT;
  version: number;
  /** Every object in it (the root included) has an `id`. */
  root: NodeData;
}

/** A prefab instance as saved in a scene or a prefab. */
export interface PrefabInstanceData {
  /** The prefab's asset id. */
  prefab: string;
  /** Its id, inside a prefab. */
  id?: string;
  name: string;
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
  /**
   * Object id → changed values, by object key (`visible`, `mesh`, `behaviours`…: replaced whole) or
   * `<component>.<field>` (`material.color`). A component key set to null removes the component, a field set to
   * null removes the field (a texture).
   */
  overrides?: Record<string, Json>;
  /** Objects of the prefab (with their descendants) this instance leaves out. */
  removed?: string[];
  /** Objects this instance adds, at `index` among the children of the prefab object `parent`. */
  added?: { parent: string; index: number; object: NodeData }[];
}

/** An object in a scene or prefab: plain, or a prefab instance. */
export type NodeData = ObjectData | PrefabInstanceData;

/** Prefab data by asset id. */
export interface PrefabLibrary {
  prefab(id: string): PrefabData | null;
}

export function isInstanceData(d: unknown): d is PrefabInstanceData {
  return isObject(d) && typeof d.prefab === 'string';
}

/** Keys of an expanded tree that aren't saved object data. */
export const EXPANDED_KEYS = ['id', 'instanceOf', 'missingPrefab'] as const;
/** The instance root's own values, saved on the instance itself rather than as overrides. */
const ROOT_KEYS = new Set(['name', 'position', 'rotation', 'scale']);
/** Object keys holding a component's fields, compared field by field. Everything else is compared whole. */
const COMPONENT_KEYS = new Set(['material', 'light', 'camera', 'rigidBody', 'shape2d', 'text2d', 'audioSource']);
const NOT_COMPARED = new Set<string>(['children', ...EXPANDED_KEYS]);

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

let idCounter = 0;
/** A new object id for a prefab. Ids only have to be unique within their prefab; never contain '/'. */
export function newNodeId(): string {
  return `${(Date.now() % 2176782336).toString(36)}${(idCounter++ % 1296).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Prefab file text: pretty JSON, like scene files. */
export function prefabText(data: PrefabData): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

const parsed = new WeakMap<Uint8Array, PrefabData | Error>();

/** The prefab in a file's bytes, upgraded to the current version (cached per byte array). Throws when it isn't one. */
export function readPrefab(bytes: Uint8Array): PrefabData {
  let p = parsed.get(bytes);
  if (!p) {
    try {
      const doc = upgradeDocument(JSON.parse(new TextDecoder().decode(bytes)), PREFAB_FORMAT, 'prefab');
      if (!isObject(doc.root)) throw new Error('Prefab has no objects');
      ensureIds(doc.root);
      p = doc as unknown as PrefabData;
    } catch (err) {
      p = err as Error;
    }
    parsed.set(bytes, p);
  }
  if (p instanceof Error) throw p;
  return p;
}

/** Gives objects of a hand-edited prefab that lack an id (or repeat one) an id from their place in the tree. */
function ensureIds(root: Json): void {
  const seen = new Set<string>();
  const visit = (o: Json, path: string) => {
    if (typeof o.id !== 'string' || !o.id || o.id.includes('/') || seen.has(o.id)) o.id = `~${path}`;
    seen.add(o.id as string);
    if (Array.isArray(o.children)) o.children.forEach((c, i) => isObject(c) && visit(c, `${path}.${i}`));
  };
  visit(root, '0');
}

/** A prefab document around `root`, at the current version. */
export function prefabDocument(root: NodeData): PrefabData {
  return { format: PREFAB_FORMAT, version: SCENE_VERSION, root };
}

// ---- ids in nested instances

/** An id of a prefab's own expansion (whose root is `prefabRoot`) as seen in an instance whose root has id `rootId`. */
export function scopedId(id: string, prefabRoot: string, rootId: string): string {
  if (rootId === prefabRoot) return id;
  return id === prefabRoot ? rootId : `${rootId}/${id}`;
}

/** The inverse of scopedId; null when `id` isn't in that instance. */
export function unscopedId(id: string, prefabRoot: string, rootId: string): string | null {
  if (rootId === prefabRoot) return id;
  if (id === rootId) return prefabRoot;
  return id.startsWith(`${rootId}/`) ? id.slice(rootId.length + 1) : null;
}

function rescope(tree: Json, prefabRoot: string, rootId: string): void {
  if (prefabRoot === rootId) return;
  const visit = (o: Json) => {
    if (typeof o.id === 'string') o.id = scopedId(o.id, prefabRoot, rootId);
    if (Array.isArray(o.children)) for (const c of o.children) if (isObject(c)) visit(c);
  };
  visit(tree);
}

// ---- expansion

/**
 * A prefab's objects as one tree (a copy): nested instances expanded, every object with its `id` and nested instance
 * roots marked with `instanceOf` (their prefab). Null when the prefab is missing or contains itself.
 */
export function expandPrefab(id: string, lib: PrefabLibrary, warnings: string[] = [], stack: string[] = []): Json | null {
  if (stack.includes(id)) {
    warnings.push('A prefab contains itself');
    return null;
  }
  const p = lib.prefab(id);
  if (!p) return null;
  return expandNode(copy(p.root) as unknown as Json, lib, warnings, [...stack, id]);
}

/** Expands the instances in a tree that's already a copy (in place where possible). */
function expandNode(d: Json, lib: PrefabLibrary, warnings: string[], stack: string[]): Json {
  if (isInstanceData(d)) return expandInstance(d, lib, warnings, stack) ?? missingPrefab(d, warnings);
  if (Array.isArray(d.children)) d.children = d.children.filter(isObject).map((c) => expandNode(c, lib, warnings, stack));
  return d;
}

/**
 * Stands in for an instance whose prefab is missing: an empty object with the instance's name and transform, carrying
 * the instance data (`missingPrefab`) so saving writes it back unchanged.
 */
export function missingPrefab(d: PrefabInstanceData, warnings: string[]): Json {
  warnings.push(`${d.name}: prefab not found`);
  const out: Json = { name: d.name, position: d.position, rotation: d.rotation, scale: d.scale, visible: true, castShadows: true, missingPrefab: copy(d) };
  if (d.id !== undefined) out.id = d.id;
  return out;
}

/** The objects of an instance: its prefab's, changed as the instance says. Null when the prefab is missing. */
export function expandInstance(inst: PrefabInstanceData, lib: PrefabLibrary, warnings: string[] = [], stack: string[] = []): Json | null {
  const tree = expandPrefab(inst.prefab, lib, warnings, stack);
  if (!tree) return null;
  const nodes = new Map<string, { node: Json; parent: Json | null }>();
  const index = (o: Json, parent: Json | null) => {
    if (typeof o.id === 'string') nodes.set(o.id, { node: o, parent });
    if (Array.isArray(o.children)) for (const c of o.children) if (isObject(c)) index(c, o);
  };
  index(tree, null);

  for (const id of Array.isArray(inst.removed) ? inst.removed : []) {
    const n = typeof id === 'string' ? nodes.get(id) : undefined;
    if (!n?.parent || !Array.isArray(n.parent.children)) continue; // the root can't be removed
    n.parent.children = n.parent.children.filter((c) => c !== n.node);
  }
  if (isObject(inst.overrides)) {
    for (const [id, values] of Object.entries(inst.overrides)) {
      const n = nodes.get(id);
      if (n && isObject(values)) applyOverrides(n.node, values, n.node === tree);
    }
  }
  const added = (Array.isArray(inst.added) ? inst.added : []).filter((a) => isObject(a) && isObject(a.object) && typeof a.parent === 'string');
  // In index order, so each one lands where it was saved.
  added.sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));
  for (const a of added) {
    const parent = nodes.get(a.parent)?.node;
    if (!parent) continue;
    const children = Array.isArray(parent.children) ? parent.children : (parent.children = []);
    const at = Math.max(0, Math.min(Math.floor(Number(a.index) || 0), children.length));
    children.splice(at, 0, expandNode(copy(a.object) as unknown as Json, lib, warnings, stack));
  }

  const prefabRoot = tree.id as string;
  for (const k of ROOT_KEYS) if (inst[k as keyof PrefabInstanceData] !== undefined) tree[k] = copy(inst[k as keyof PrefabInstanceData]);
  tree.instanceOf = inst.prefab;
  if (typeof inst.id === 'string') rescope(tree, prefabRoot, inst.id);
  return tree;
}

function applyOverrides(node: Json, values: Json, isRoot: boolean): void {
  for (const [key, v] of Object.entries(values)) {
    const dot = key.indexOf('.');
    if (dot < 0) {
      if (NOT_COMPARED.has(key) || (isRoot && ROOT_KEYS.has(key))) continue;
      if (v === null) delete node[key];
      else node[key] = copy(v);
      continue;
    }
    const component = node[key.slice(0, dot)];
    // Overrides of a component the prefab no longer has are dropped.
    if (!isObject(component)) continue;
    if (v === null) delete component[key.slice(dot + 1)];
    else component[key.slice(dot + 1)] = copy(v);
  }
}

// ---- differences

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (!isObject(a) || !isObject(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => k in b && same(a[k], b[k]));
}

/** How an object differs from its prefab's version, as overrides; null when it doesn't. */
function diffObject(live: Json, base: Json, isRoot: boolean): Json | null {
  const out: Json = {};
  for (const k of new Set([...Object.keys(base), ...Object.keys(live)])) {
    if (NOT_COMPARED.has(k) || (isRoot && ROOT_KEYS.has(k))) continue;
    const a = live[k], b = base[k];
    if (a === undefined) out[k] = null;
    else if (b === undefined) out[k] = a;
    else if (COMPONENT_KEYS.has(k) && isObject(a) && isObject(b)) {
      for (const f of new Set([...Object.keys(b), ...Object.keys(a)])) if (!same(a[f], b[f])) out[`${k}.${f}`] = a[f] ?? null;
    } else if (!same(a, b)) out[k] = a;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The changes that turn `base` (a prefab's expansion) into `live` (the same objects as saved now, by id, plus objects
 * in `added` that the prefab doesn't have). Children of `live` in `added` are saved whole, at their index.
 */
export function diffInstance(live: Json, base: Json, added: ReadonlySet<Json>): Pick<PrefabInstanceData, 'overrides' | 'removed' | 'added'> {
  const overrides: Record<string, Json> = {};
  const removed: string[] = [];
  const extra: NonNullable<PrefabInstanceData['added']> = [];
  const walk = (l: Json, b: Json) => {
    const id = b.id as string;
    const o = diffObject(l, b, l === live);
    if (o) overrides[id] = o;
    const lc = Array.isArray(l.children) ? (l.children as Json[]) : [];
    const bc = Array.isArray(b.children) ? (b.children as Json[]) : [];
    lc.forEach((c, index) => {
      if (added.has(c)) extra.push({ parent: id, index, object: c as unknown as NodeData });
    });
    const byId = new Map(lc.filter((c) => !added.has(c)).map((c) => [c.id, c]));
    for (const c of bc) {
      const match = byId.get(c.id);
      if (match) walk(match, c);
      else removed.push(c.id as string);
    }
  };
  walk(live, base);
  return {
    ...(Object.keys(overrides).length ? { overrides } : {}),
    ...(removed.length ? { removed } : {}),
    ...(extra.length ? { added: extra } : {}),
  };
}

// ---- dependencies

/** Prefab ids that data uses (instances anywhere in it), and the ones those prefabs use in turn. */
export function prefabDependencies(data: unknown, lib: PrefabLibrary, out = new Set<string>()): Set<string> {
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (isObject(v)) {
      if (typeof v.prefab === 'string' && !out.has(v.prefab)) {
        out.add(v.prefab);
        const p = lib.prefab(v.prefab);
        if (p) visit(p.root);
      }
      for (const x of Object.values(v)) if (typeof x === 'object') visit(x);
    }
  };
  visit(data);
  return out;
}
