import { check, eq } from './harness';
import { Scene } from '@root/src/engine/scene.ts';
import { Texture } from '@root/src/engine/material.ts';
import { Sky } from '@root/src/engine/sky.ts';
import { applySceneData, sceneAssetIds, serializeScene } from '@root/src/engine/serialize.ts';
import { Project, ProjectResources } from '@root/src/engine/project.ts';

// Skies save with the scene's settings; an image sky's texture is a ref to an image asset of the project.

const image = new Texture({ width: 64, height: 32 } as ImageBitmap, 'pano');
image.ref = { asset: 'pano', index: 0 };

// ---- round trip
{
  const scene = new Scene();
  Object.assign(scene.sky, { mode: 'image', texture: image, rotation: 45, intensity: 2, lighting: 0.5, top: [1, 0, 0] });
  const warnings: string[] = [];
  const data = serializeScene(scene, warnings);
  eq('saves without warnings', warnings, []);
  eq('the image is saved as a ref', (data.settings.sky as { texture: unknown }).texture, { asset: 'pano', index: 0 });
  eq('the image is an asset the scene uses', [...sceneAssetIds(data)], ['pano']);

  const res = new ProjectResources(new Project());
  res.register('pano', { meshes: [], textures: [image] });
  const loaded = new Scene();
  const loadWarnings: string[] = [];
  applySceneData(loaded, JSON.parse(JSON.stringify(data)), res, loadWarnings);
  eq('loads without warnings', loadWarnings, []);
  const sky = loaded.sky;
  eq('fields round-trip', [sky.mode, sky.rotation, sky.intensity, sky.lighting, sky.top], ['image', 45, 2, 0.5, [1, 0, 0]]);
  check('the texture resolves', sky.texture === image);
  eq('saves again identically', serializeScene(loaded), data);

  const copy = scene.clone();
  check('clones copy the sky', copy.sky !== scene.sky && copy.sky.mode === 'image' && copy.sky.texture === image && copy.sky.top !== scene.sky.top);
}

// ---- older files and bad values
{
  const scene = new Scene();
  scene.sky.mode = 'gradient';
  const old = serializeScene(new Scene());
  delete (old.settings as Record<string, unknown>).sky;
  applySceneData(scene, old, new ProjectResources(new Project()));
  eq('a scene saved before skies gets the default, not the last scene\'s', scene.sky.mode, new Sky().mode);

  const bad = serializeScene(new Scene());
  (bad.settings as Record<string, unknown>).sky = { mode: 'nebula', texture: { asset: 'gone', index: 0 } };
  const warnings: string[] = [];
  applySceneData(scene, bad, new ProjectResources(new Project()), warnings);
  eq('an unknown mode falls back to color', scene.sky.mode, 'color');
  eq('a missing image warns', warnings, ['Sky: image not found']);
}

// ---- builds ship the sky image
{
  const p = new Project();
  const withSky = new Scene();
  Object.assign(withSky.sky, { mode: 'image', texture: image });
  p.scenes = [{ id: 'a', name: 'Sky', data: serializeScene(withSky) }, { id: 'b', name: 'Plain', data: serializeScene(new Scene()) }];
  p.assets = [{ id: 'pano', name: 'pano', files: [{ name: 'pano.jpg', bytes: new Uint8Array([1]) }] }];
  eq('an image sky ships with the build', p.subset([p.scenes[0]]).assets.map((a) => a.id), ['pano']);
  eq('...and only when used', p.subset([p.scenes[1]]).assets.map((a) => a.id), []);
  eq('the project keeps it', p.referencedAssets().map((a) => a.id), ['pano']);
}

// ---- an image sky without an image draws the gradient
{
  const sky = new Sky();
  sky.mode = 'image';
  eq('falls back to the gradient', sky.effectiveMode, 'gradient');
  sky.texture = image;
  eq('draws the image once there is one', sky.effectiveMode, 'image');
}

// ---- post-processing saves with the scene's settings too
{
  const scene = new Scene();
  Object.assign(scene.post, { antialiasing: 'taa', bloom: 0.8, bloomThreshold: 2, bloomScatter: 0.4 });
  const data = serializeScene(scene);
  eq('post-processing is saved', data.settings.post, { antialiasing: 'taa', bloom: 0.8, bloomThreshold: 2, bloomScatter: 0.4 });
  const loaded = new Scene();
  applySceneData(loaded, JSON.parse(JSON.stringify(data)), new ProjectResources(new Project()));
  eq('and loaded', [loaded.post.antialiasing, loaded.post.bloom, loaded.post.bloomThreshold, loaded.post.bloomScatter], ['taa', 0.8, 2, 0.4]);
  check('clones copy it', scene.clone().post.antialiasing === 'taa' && scene.clone().post !== scene.post);

  const old = serializeScene(new Scene());
  delete (old.settings as Record<string, unknown>).post;
  applySceneData(loaded, old, new ProjectResources(new Project()));
  eq('a scene saved before it existed gets the defaults, not the last scene\'s', [loaded.post.antialiasing, loaded.post.bloom], ['msaa', 0]);

  const bad = serializeScene(new Scene());
  (bad.settings as Record<string, unknown>).post = { antialiasing: 'fxaa', bloom: -1, bloomScatter: 3 };
  applySceneData(loaded, bad, new ProjectResources(new Project()));
  eq('bad values fall back or are clamped', [loaded.post.antialiasing, loaded.post.bloom, loaded.post.bloomScatter], ['msaa', 0, 1]);
}
