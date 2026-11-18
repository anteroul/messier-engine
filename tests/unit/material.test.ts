import { check, eq } from './harness';
import { GameObject, Scene } from '@root/src/engine/scene.ts';
import { Material, Texture } from '@root/src/engine/material.ts';
import { applySceneData, collectAssetIds, serializeScene, tagAssetResources } from '@root/src/engine/serialize.ts';
import { Project, ProjectResources } from '@root/src/engine/project.ts';

// Material texture maps: every slot saves as a ref, and imported models number base color textures first.

const image = (name: string) => new Texture({ width: 4, height: 4 } as ImageBitmap, name);

// ---- numbering: base color textures keep the indices they had before the other slots were loaded
{
  const [baseA, normalA, orm, baseB, glow] = ['baseA', 'normalA', 'orm', 'baseB', 'glow'].map(image);
  const root = new GameObject('Model');
  const a = new GameObject('A');
  a.material = Object.assign(new Material('a'), { baseColorTexture: baseA, normalTexture: normalA, metallicRoughnessTexture: orm, occlusionTexture: orm });
  const b = new GameObject('B');
  b.material = Object.assign(new Material('b'), { baseColorTexture: baseB, emissiveTexture: glow });
  root.add(a);
  root.add(b);
  const { textures } = tagAssetResources(root, 'model');
  eq('base colors first, then the other slots, each image once', textures.map((t) => t.name), ['baseA', 'baseB', 'normalA', 'orm', 'glow']);
  eq('refs follow that order', textures.map((t) => (t.ref && 'index' in t.ref ? t.ref.index : -1)), [0, 1, 2, 3, 4]);
}

// ---- round trip
{
  const [base, normal, orm, glow] = ['base', 'normal', 'orm', 'glow'].map(image);
  [base, normal, orm, glow].forEach((t, i) => (t.ref = { asset: 'model', index: i }));
  const scene = new Scene();
  const obj = new GameObject('Crate');
  obj.material = Object.assign(new Material('crate'), {
    baseColorTexture: base, normalTexture: normal, normalScale: 0.5, metallicRoughnessTexture: orm, occlusionTexture: orm,
    occlusionStrength: 0.75, emissiveTexture: glow,
  });
  scene.add(obj);
  const warnings: string[] = [];
  const data = serializeScene(scene, warnings);
  eq('saves without warnings', warnings, []);
  const m = data.objects[0].material;
  eq('the base color is saved under its slot name', m.baseColorTexture, { asset: 'model', index: 0 });
  eq('other slots save as refs', [m.normalTexture, m.metallicRoughnessTexture, m.occlusionTexture, m.emissiveTexture].map((r) => r.index), [1, 2, 2, 3]);
  eq('the textures count as used assets', [...collectAssetIds(data.objects)], ['model']);

  const res = new ProjectResources(new Project());
  res.register('model', { meshes: [], textures: [base, normal, orm, glow] });
  const loaded = new Scene();
  const loadWarnings: string[] = [];
  applySceneData(loaded, JSON.parse(JSON.stringify(data)), res, loadWarnings);
  eq('loads without warnings', loadWarnings, []);
  const mat = loaded.findByName('Crate')!.material!;
  check('the textures resolve', mat.baseColorTexture === base && mat.normalTexture === normal && mat.metallicRoughnessTexture === orm &&
    mat.occlusionTexture === orm && mat.emissiveTexture === glow);
  eq('the strengths round-trip', [mat.normalScale, mat.occlusionStrength], [0.5, 0.75]);
  eq('saves again identically', serializeScene(loaded), data);

  const copy = mat.clone();
  check('clone copies the maps', copy.normalTexture === normal && copy.emissiveTexture === glow && copy.normalScale === 0.5 && copy.occlusionStrength === 0.75);
}

// ---- older files have no maps
{
  const loaded = new Scene();
  const warnings: string[] = [];
  applySceneData(loaded, { format: 'messier-scene', version: 1, settings: {}, objects: [{
    name: 'Old', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], visible: true, castShadows: true, material: { roughness: 0.3 },
  }] } as never, new ProjectResources(new Project()), warnings);
  const mat = loaded.findByName('Old')!.material!;
  check('defaults for missing maps', !mat.normalTexture && !mat.occlusionTexture && mat.normalScale === 1 && mat.occlusionStrength === 1 && mat.roughness === 0.3);
}
