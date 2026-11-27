import { check, eq, throws } from './harness';
import { GameObject, Scene } from '@root/src/engine/scene.ts';
import { Material } from '@root/src/engine/material.ts';
import { Light } from '@root/src/engine/light.ts';
import { createCube, createSphere } from '@root/src/engine/primitives.ts';
import { Project, ProjectResources, type Asset } from '@root/src/engine/project.ts';
import {
  applySceneData, deserializeObject, prefabFromObject, serializeObject, serializeScene, unpackInstance, upgradeSceneData,
} from '@root/src/engine/serialize.ts';
import { expandPrefab, prefabText, readPrefab, type PrefabData, type PrefabInstanceData } from '@root/src/engine/prefab.ts';
import { SCENE_VERSION } from '@root/src/engine/sceneFormat.ts';

// Prefabs: saved object trees placed as instances that keep only their changes, nested prefabs, and the scene format
// versions they came with.

const project = new Project();
const res = new ProjectResources(project);

function setPrefab(id: string, name: string, data: PrefabData): Asset {
  const bytes = new TextEncoder().encode(prefabText(data));
  let a = project.getAsset(id);
  if (a) a.files[0] = { name: a.files[0].name, bytes };
  else project.assets.push((a = { id, name, path: `${name}.prefab`, files: [{ name: `${name}.prefab`, bytes }] }));
  return a;
}

function newScene(): Scene {
  const s = new Scene();
  s.prefabs = res;
  return s;
}

/** A body with a gun and a lamp. */
function enemy(): GameObject {
  const body = new GameObject('Enemy');
  body.mesh = createCube(1);
  body.material = new Material('body', { baseColor: [0.8, 0.1, 0.1, 1] });
  const gun = new GameObject('Gun');
  gun.mesh = createSphere(0.25);
  gun.material = new Material('gun', { baseColor: [0.2, 0.2, 0.2, 1] });
  gun.transform.position = [0.6, 0, 0];
  const lamp = new GameObject('Lamp');
  lamp.light = new Light('point', [1, 1, 0.5], 2);
  body.add(gun);
  body.add(lamp);
  return body;
}

const json = (v: unknown) => JSON.parse(JSON.stringify(v));
const names = (o: GameObject): unknown => [o.name, ...o.children.map(names)];

// ---- making a prefab, and plain instances
const scene = newScene();
const source = enemy();
scene.add(source);
const enemyData = prefabFromObject(source, res);
setPrefab('enemy', 'Enemy', enemyData);
{
  const ids: string[] = [];
  const visit = (d: any) => {
    ids.push(d.id);
    (d.children ?? []).forEach(visit);
  };
  visit(enemyData.root);
  check('every object of a prefab has an id', ids.length === 3 && ids.every((id) => typeof id === 'string' && id.length > 3) && new Set(ids).size === 3, ids.join());
  eq('the prefab file reads back', readPrefab(new TextEncoder().encode(prefabText(enemyData))), json(enemyData));

  const a = scene.instantiate('Enemy')!;
  a.transform.position = [3, 0, 0];
  eq('an instance has the prefab objects', names(a), ['Enemy', ['Gun'], ['Lamp']]);
  check('an instance is linked', a.prefab === 'enemy' && a.children.every((c) => c.prefabNode !== null) && a.children.every((c) => c.prefab === null));
  check('by path too', scene.instantiate('Enemy.prefab') !== null && scene.instantiate('enemy') !== null);
  const saved = serializeObject(a, res) as PrefabInstanceData;
  eq('an unchanged instance saves as its link', saved, { prefab: 'enemy', name: 'Enemy', position: [3, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
  check('meshes are shared', a.children[0].mesh === res.mesh({ primitive: 'sphere', args: [0.25, 48, 24] }));
}

// ---- overrides, removed and added objects
{
  const a = scene.instantiate('Enemy')!;
  a.name = 'Boss';
  a.find('Gun')!.material!.baseColor = [0, 1, 0, 1];
  a.find('Gun')!.transform.scale = [2, 2, 2];
  a.material = null;
  a.find('Lamp')!.parent!.remove(a.find('Lamp')!);
  const hat = new GameObject('Hat');
  hat.mesh = createCube(0.5);
  a.add(hat, 0);
  const extra = scene.instantiate('Enemy', a.find('Gun')!)!; // an instance added to an instance
  extra.transform.scale = [0.5, 0.5, 0.5];
  const data = serializeObject(a, res) as PrefabInstanceData;
  const gunId = enemyData.root.children![0].id!;
  const rootId = enemyData.root.id!;
  eq('field overrides by object id', data.overrides, { [rootId]: { material: null }, [gunId]: { scale: [2, 2, 2], 'material.baseColor': [0, 1, 0, 1] } });
  eq('removed objects', data.removed, [enemyData.root.children![1].id]);
  eq('added objects, where they go', data.added!.map((x) => [x.parent, x.index, x.object.name]), [[rootId, 0, 'Hat'], [gunId, 0, 'Enemy']]);
  check('an added instance stays an instance', (data.added![1].object as PrefabInstanceData).prefab === 'enemy' && !('id' in data.added![1].object));
  const back = deserializeObject(json(data), scene, res);
  eq('loads back', names(back), ['Boss', ['Hat'], ['Gun', ['Enemy', ['Gun'], ['Lamp']]]]);
  check('loaded values', back.material === null && back.find('Gun')!.material!.baseColor[1] === 1 && back.find('Gun/Enemy')!.prefab === 'enemy');
  eq('saves again identically', serializeObject(back, res), data);

  // A duplicate of an object of the instance is an added object, not a second copy of it.
  const dup = back.find('Gun')!.clone();
  back.add(dup);
  const withDup = serializeObject(back, res) as PrefabInstanceData;
  eq('a duplicate is added', withDup.added!.map((x) => [x.index, x.object.name, 'id' in x.object]), [[0, 'Hat', false], [2, 'Gun', false], [0, 'Enemy', false]]);
}

// ---- editing the prefab reaches instances, except where they override it
{
  const a = scene.instantiate('Enemy')!;
  a.find('Gun')!.material!.baseColor = [0, 0, 1, 1];
  const b = scene.instantiate('Enemy')!;
  b.find('Lamp')!.light!.intensity = 7;
  b.find('Gun')!.material!.baseColor = [1, 1, 1, 1];
  const saved = serializeObject(a, res);
  setPrefab('enemy', 'Enemy', prefabFromObject(b, res, [], 'enemy'));
  check('apply keeps object ids', expandPrefab('enemy', res)!.id === enemyData.root.id);
  const a2 = deserializeObject(json(saved), scene, res);
  eq('the instance gets the new values, keeping its own', [a2.find('Lamp')!.light!.intensity, a2.find('Gun')!.material!.baseColor], [7, [0, 0, 1, 1]]);
  const fresh = scene.instantiate('Enemy')!;
  eq('the applied instance has no changes left', serializeObject(fresh, res), { prefab: 'enemy', name: 'Enemy', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
}

// ---- nested prefabs and variants
{
  const tank = new GameObject('Tank');
  tank.mesh = createCube(2);
  const left = scene.instantiate('Enemy', tank)!;
  left.name = 'Left';
  left.transform.position = [-1, 1, 0];
  const right = scene.instantiate('Enemy', tank)!;
  right.name = 'Right';
  right.transform.position = [1, 1, 0];
  right.find('Gun')!.material!.roughness = 0.1;
  const tankData = prefabFromObject(tank, res);
  setPrefab('tank', 'Tank', tankData);
  const [l, r] = tankData.root.children as PrefabInstanceData[];
  check('instances in a prefab are nested instances', l.prefab === 'enemy' && r.prefab === 'enemy' && !!l.id && l.id !== r.id && !l.overrides);
  eq('a nested instance keeps its changes', Object.values(r.overrides!), [{ 'material.roughness': 0.1 }]);

  const t = scene.instantiate('Tank')!;
  const ids: string[] = [];
  t.traverse((o) => void ids.push(o.prefabNode!));
  check('ids stay unique with a prefab nested twice', ids.length === 7 && new Set(ids).size === 7, ids.join(' '));
  check('nested roots link their prefab', t.find('Left')!.prefab === 'enemy' && t.find('Right')!.prefab === 'enemy' && t.prefab === 'tank');
  eq('an unchanged nested instance', Object.keys(serializeObject(t, res)), ['prefab', 'name', 'position', 'rotation', 'scale']);

  t.find('Right/Gun')!.material!.baseColor = [1, 1, 0, 1];
  t.find('Left/Lamp')!.visible = false;
  const data = serializeObject(t, res) as PrefabInstanceData;
  const keys = Object.keys(data.overrides!);
  check('overrides reach into nested instances', keys.length === 2 && keys.every((k) => k.includes('/')), keys.join());
  const back = deserializeObject(json(data), scene, res);
  check('nested overrides load', back.find('Right/Gun')!.material!.baseColor[1] === 1 && back.find('Right/Gun')!.material!.roughness === 0.1 && !back.find('Left/Lamp')!.visible);
  eq('nested instance saves again identically', serializeObject(back, res), data);

  // Applying writes the nested changes into the nested instances, not into Enemy.
  setPrefab('tank', 'Tank', prefabFromObject(back, res, [], 'tank'));
  const tank2 = project.prefabData('tank')!;
  const right2 = (tank2.root.children as PrefabInstanceData[])[1];
  check('apply keeps nested changes nested', right2.prefab === 'enemy' && Object.keys(right2.overrides!).every((k) => !k.includes('/')) &&
    readPrefab(project.getAsset('enemy')!.files[0].bytes).root.children![0].id === enemyData.root.children![0].id);
  const plain = scene.instantiate('Tank')!;
  check('new instances get it', plain.find('Right/Gun')!.material!.baseColor[0] === 1 && !plain.find('Left/Lamp')!.visible);

  // A variant: a prefab made from an instance.
  const v = scene.instantiate('Enemy')!;
  v.find('Gun')!.transform.position = [0, 1, 0];
  const variant = prefabFromObject(v, res);
  check('a prefab of an instance is a variant', (variant.root as PrefabInstanceData).prefab === 'enemy');
  setPrefab('heavy', 'Heavy', variant);
  const h = scene.instantiate('Heavy')!;
  eq('a variant has its base prefab\'s objects with its changes', [names(h), h.find('Gun')!.transform.position], [['Enemy', ['Gun'], ['Lamp']], [0, 1, 0]]);
  h.find('Lamp')!.light!.range = 3;
  const hd = serializeObject(h, res) as PrefabInstanceData;
  eq('an instance of a variant round-trips', serializeObject(deserializeObject(json(hd), scene, res), res), hd);
  setPrefab('heavy', 'Heavy', prefabFromObject(h, res, [], 'heavy'));
  check('a variant applies to itself', (project.prefabData('heavy')!.root as PrefabInstanceData).prefab === 'enemy' && scene.instantiate('Heavy')!.find('Lamp')!.light!.range === 3);

  // A prefab can't hold itself.
  const loop = scene.instantiate('Tank')!;
  scene.instantiate('Tank', loop);
  throws('a prefab containing itself is refused', () => prefabFromObject(loop, res, [], 'tank'), /itself/);
}

// ---- unpacking
{
  const t = scene.instantiate('Tank')!;
  t.find('Left/Gun')!.name = 'Cannon';
  const undo = unpackInstance(t, res);
  const data = serializeObject(t, res) as any;
  check('an unpacked instance saves as plain objects', !('prefab' in data) && data.children.length === 2 && data.children[0].prefab === 'enemy');
  eq('nested instances stay instances with their changes', Object.values(data.children[0].overrides), [{ name: 'Cannon' }, { visible: false }]);
  undo();
  eq('unpacking undoes', Object.keys(serializeObject(t, res)).slice(0, 1), ['prefab']);
}

// ---- missing prefabs, scenes, projects
{
  const s = newScene();
  const t = s.instantiate('Tank')!;
  t.transform.position = [0, 0, 5];
  s.root.children[0].find('Right/Gun')!.material!.metallic = 1;
  const data = serializeScene(s);
  const gone = json(data);
  gone.objects[0].prefab = 'gone';
  const warnings: string[] = [];
  const loaded = newScene();
  applySceneData(loaded, gone, res, warnings);
  eq('a missing prefab is a warning', warnings, ['Tank: prefab not found']);
  const placeholder = loaded.root.children[0];
  check('it leaves a placeholder', placeholder.children.length === 0 && placeholder.transform.position[2] === 5);
  placeholder.transform.position = [1, 2, 3];
  const resaved = serializeScene(loaded).objects[0] as PrefabInstanceData;
  eq('which saves the instance unchanged', { ...resaved, position: [0, 0, 5] }, gone.objects[0]);

  const copy = s.clone();
  eq('Play copies keep prefab links', serializeScene(copy), data);
  project.scenes = [{ id: 's', name: 'Main', data }];
  project.assets.push({ id: 'unused-model', name: 'unused', files: [{ name: 'x.obj', bytes: new Uint8Array(4) }] });
  eq('every prefab ships, with what it uses', project.referencedAssets().map((a) => a.id), ['enemy', 'tank', 'heavy']);
  const decoded = Project.decode(project.subset(project.scenes).encode());
  const r2 = new ProjectResources(decoded);
  const played = await r2.instantiate(decoded.scenes[0], s.scripts);
  check('a built game loads instances', played.root.children[0].find('Right/Gun')!.material!.metallic === 1 && played.instantiate('Heavy') !== null);
}

// ---- scene format versions
{
  const v1 = {
    format: 'messier-scene', version: 1, settings: {},
    objects: [{ name: 'Crate', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], visible: true, castShadows: true,
      material: { color: [1, 1, 1], texture: { asset: 'wood', index: 0 } }, children: [{ name: 'Lid', material: { texture: { asset: 'wood', index: 1 } } }] }],
  };
  const before = JSON.stringify(v1);
  const up = upgradeSceneData(v1) as any;
  eq('version 1 is upgraded', [up.version, up.objects[0].material, up.objects[0].children[0].material],
    [SCENE_VERSION, { color: [1, 1, 1], baseColorTexture: { asset: 'wood', index: 0 } }, { baseColorTexture: { asset: 'wood', index: 1 } }]);
  check('the original is left alone', JSON.stringify(v1) === before);
  check('a current scene is used as is', upgradeSceneData(up) === up);
  throws('newer versions are refused', () => upgradeSceneData({ ...up, version: SCENE_VERSION + 1 }), /newer Messier/);
  throws('other files are refused', () => upgradeSceneData({ format: 'other' }), /Not a Messier scene/);
  const oldPrefab = new TextEncoder().encode(JSON.stringify({ format: 'messier-prefab', version: 1, root: { name: 'Old', material: { texture: { asset: 'wood', index: 0 } }, children: [{ name: 'A' }, { name: 'B', id: 'x' }] } }));
  const p = readPrefab(oldPrefab) as any;
  eq('prefabs are upgraded too, and objects without ids get one', [p.root.material, p.root.id, p.root.children.map((c: any) => c.id)],
    [{ baseColorTexture: { asset: 'wood', index: 0 } }, '~0', ['~0.0', 'x']]);
  const v2 = { format: 'messier-scene', version: 2, settings: { exposure: 1.2, shadowExtent: 16 }, objects: [] };
  eq('version 2: the shadow extent becomes a shadow distance', (upgradeSceneData(v2) as any).settings, { exposure: 1.2, shadowDistance: 48 });
  const loaded = newScene();
  applySceneData(loaded, v2, res);
  eq('and loads as one', [loaded.shadowDistance, loaded.shadowCascades], [48, 4]);
}
