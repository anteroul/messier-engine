import { isObject, type Json } from './data';

// Versions of the object data that scene files (scenes/*.messier) and prefab files (assets/**/*.prefab) hold. Both
// share one version number, since they share the object format. Readers upgrade older documents step by step
// through MIGRATIONS before they look at them, so the rest of the engine only ever sees the current version, and
// refuse newer ones. Saving always writes the current version.

export const SCENE_FORMAT = 'messier-scene';
export const PREFAB_FORMAT = 'messier-prefab';
/** Version of scene and prefab files. Bump it, with a migration, for changes that old readers would misread. */
export const SCENE_VERSION = 3;

/**
 * Upgrades, in order: MIGRATIONS[i] turns a version i + 1 document (a scene or a prefab, as parsed JSON) into
 * version i + 2, in place. They run on a copy, never see newer data, and must not fail on odd input (loading keeps
 * defaults for what's missing or mistyped anyway). A migration that renames an object key must also rename it in
 * instance overrides, whose keys are `<key>` or `<component>.<field>`.
 */
const MIGRATIONS: ((doc: Json) => void)[] = [
  // 2: the base color texture is saved under `baseColorTexture`, like the other texture slots (it was `texture`).
  // Prefab instances are new in 2 as well; version 1 files have none.
  (doc) =>
    forEachObject(doc, (o) => {
      const m = o.material;
      if (!isObject(m) || !('texture' in m)) return;
      if (!('baseColorTexture' in m)) m.baseColorTexture = m.texture;
      delete m.texture;
    }),
  // 3: shadows are cascaded and reach `shadowDistance` from the camera, instead of a box `shadowExtent` across each
  // way around the camera's target. Three times the extent covers about what the box did from a typical view.
  (doc) => {
    const s = doc.settings;
    if (!isObject(s) || !('shadowExtent' in s)) return;
    if (typeof s.shadowExtent === 'number' && !('shadowDistance' in s)) s.shadowDistance = s.shadowExtent * 3;
    delete s.shadowExtent;
  },
];

/** Calls `fn` for every object of a scene or prefab document: top-level ones, children, objects added to instances. */
export function forEachObject(doc: Json, fn: (obj: Json) => void): void {
  const visit = (o: unknown): void => {
    if (!isObject(o)) return;
    fn(o);
    if (Array.isArray(o.children)) o.children.forEach(visit);
    if (Array.isArray(o.added)) for (const a of o.added) if (isObject(a)) visit(a.object);
  };
  if (Array.isArray(doc.objects)) doc.objects.forEach(visit);
  visit(doc.root);
}

/**
 * `data` as a current-version document of `format` ('messier-scene' or 'messier-prefab'): itself when it is current,
 * else an upgraded copy. Throws when it isn't such a document or was saved by a newer version. `what` names it in
 * errors ('scene', 'prefab').
 */
export function upgradeDocument(data: unknown, format: string, what: string): Json {
  const What = what[0].toUpperCase() + what.slice(1);
  if (!isObject(data) || data.format !== format) throw new Error(`Not a Messier ${what}`);
  const v = data.version;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new Error(`${What} has no version`);
  if (v > SCENE_VERSION) throw new Error(`${What} was saved by a newer Messier (${what} format ${v}; this version reads up to ${SCENE_VERSION})`);
  if (v === SCENE_VERSION) return data;
  const doc = JSON.parse(JSON.stringify(data)) as Json;
  for (let i = v; i < SCENE_VERSION; i++) MIGRATIONS[i - 1](doc);
  doc.version = SCENE_VERSION;
  return doc;
}

if (MIGRATIONS.length !== SCENE_VERSION - 1) throw new Error('sceneFormat: every scene version needs a migration');
