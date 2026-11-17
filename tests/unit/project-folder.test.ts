import { readFileSync } from 'node:fs';
import { check, eq } from './harness';
import { GameObject, Scene } from '@root/src/engine/scene.ts';
import { Project, ProjectResources } from '@root/src/engine/project.ts';
import { serializeScene } from '@root/src/engine/serialize.ts';
import { loadModelAsset, loadImageAsset } from '@root/src/engine/loaders/index.ts';
import { Texture } from '@root/src/engine/material.ts';
import {
  MemoryFolder, TSCONFIG_PATH, TSCONFIG_TEXT, TYPES_PATH, diffSnapshots, listFiles, loadProjectFolder, readMeta, snapshotFolder, writeProjectFolder,
  writeTypeFiles, folderResolver,
} from '@root/src/engine/projectFolder.ts';

// The project folder format, against an in-memory folder.

const root = process.env.PROJECT_ROOT!;
// Node can't decode images; the loaders only need a texture to exist.
Object.assign(globalThis, { createImageBitmap: async () => ({ width: 2, height: 1, close() {} }) });

const bytesOf = (path: string) => {
  const b = readFileSync(`${root}/${path}`);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

/** A browser-style project: random scene ids, an OBJ model with its .mtl, an image used as the sky. */
async function sampleProject(): Promise<Project> {
  const p = new Project();
  p.name = 'Folder Test';
  const { model, asset } = await loadModelAsset('icosahedron.obj', bytesOf('public/models/icosahedron.obj'), async (uri) => bytesOf(`public/models/${uri}`), 'ico');
  const { texture, asset: image } = await loadImageAsset('sunset.png', png.slice().buffer, 'sunset');
  const main = new Scene();
  main.add(model);
  Object.assign(main.sky, { mode: 'image', texture });
  const level = new Scene();
  level.add(new GameObject('Player'));
  p.scenes = [{ id: 'x1', name: 'Main', data: serializeScene(main) }, { id: 'x2', name: 'Level 1', data: serializeScene(level) }];
  p.startScene = 'x1';
  p.build = { title: 'Game', scenes: [{ id: 'x2', enabled: true }, { id: 'x1', enabled: false }] };
  p.scripts = [{ name: 'Spin', source: 'export default class Spin {}\n' }];
  p.assets = [asset, image];
  return p;
}

// ---- write, then read back
{
  const io = new MemoryFolder();
  const written = await writeProjectFolder(io, await sampleProject());
  eq('folder layout', await listFiles(io), [
    'assets/icosahedron/icosahedron.mtl', 'assets/icosahedron/icosahedron.mtl.meta', 'assets/icosahedron/icosahedron.obj',
    'assets/icosahedron/icosahedron.obj.meta', 'assets/sunset.png', 'assets/sunset.png.meta',
    'project.json', 'scenes/Level 1.messier', 'scenes/Main.messier', 'scripts/Spin.ts',
  ]);
  eq('scene ids become paths', written.scenes.map((s) => s.id), ['scenes/Main.messier', 'scenes/Level 1.messier']);
  eq('build settings follow', written.build.scenes, [{ id: 'scenes/Level 1.messier', enabled: true }, { id: 'scenes/Main.messier', enabled: false }]);
  eq('asset ids are kept in .meta files', [await readMeta(io, 'assets/icosahedron/icosahedron.obj'), await readMeta(io, 'assets/sunset.png')], ['ico', 'sunset']);

  const { project, resources, warnings } = await loadProjectFolder(io);
  eq('loads without warnings', warnings, []);
  eq('name and start scene', [project.name, project.startScene], ['Folder Test', 'scenes/Main.messier']);
  eq('scenes', project.scenes.map((s) => s.name), ['Level 1', 'Main']);
  eq('scene data round-trips', project.getScene('scenes/Main.messier')?.data, written.getScene('scenes/Main.messier')?.data);
  eq('scripts are files', project.scripts, [{ name: 'Spin', source: 'export default class Spin {}\n' }]);
  eq('assets with their paths', project.assets.map((a) => `${a.id}:${a.path}`), [
    'ico-1:icosahedron/icosahedron.mtl', 'ico:icosahedron/icosahedron.obj', 'sunset:sunset.png',
  ]);
  eq('a model keeps its companion files', project.getAsset('ico')?.files.map((f) => f.name), ['icosahedron.obj', 'icosahedron.mtl']);
  check('model meshes resolve', resources.mesh({ asset: 'ico', index: 0 }) !== null);
  check('the model hierarchy is kept for placing copies', resources.model('ico') instanceof GameObject);
  check('the image resolves', resources.texture({ asset: 'sunset', index: 0 }) instanceof Texture);
  eq('builds still pack only what scenes use', project.referencedAssets().map((a) => a.id), ['ico', 'sunset']);
  const again = await writeProjectFolder(new MemoryFolder(), project);
  eq('writing a loaded folder again keeps its paths', again.assets.map((a) => a.path), project.assets.map((a) => a.path));
}

// ---- .meta files: moves keep ids, new files get one, copies get their own
{
  const io = new MemoryFolder();
  await writeProjectFolder(io, await sampleProject());
  for (const f of ['sunset.png', 'sunset.png.meta']) {
    await io.write(`assets/sky/${f}`, await io.read(`assets/${f}`));
    await io.remove(`assets/${f}`);
  }
  await io.write('assets/extra.png', png);
  let loaded = await loadProjectFolder(io);
  eq('a file moved with its .meta keeps its id', loaded.project.getAsset('sunset')?.path, 'sky/sunset.png');
  const extraId = await readMeta(io, 'assets/extra.png');
  check('a new file gets a .meta', !!extraId);
  loaded = await loadProjectFolder(io);
  eq('...and keeps that id', loaded.project.assets.find((a) => a.path === 'extra.png')?.id, extraId);

  await io.write('assets/copy.png', png);
  await io.write('assets/copy.png.meta', await io.read('assets/sky/sunset.png.meta'));
  loaded = await loadProjectFolder(io);
  const copy = loaded.project.assets.find((a) => a.path === 'copy.png');
  check('a copy that brought its original\'s .meta gets a new id', !!copy && copy.id !== 'sunset' && loaded.project.getAsset('sunset')?.path === 'sky/sunset.png');
  check('...with a warning', loaded.warnings.some((w) => w.includes('copy.png')), loaded.warnings.join('; '));
}

// ---- change detection
{
  const io = new MemoryFolder();
  await io.write('a.txt', 'a');
  await io.write('b/c.txt', 'c');
  const before = await snapshotFolder(io);
  await io.write('a.txt', 'changed');
  await io.write('d.txt', 'd');
  await io.remove('b');
  eq('snapshot diff', diffSnapshots(before, await snapshotFolder(io)), { added: ['d.txt'], changed: ['a.txt'], removed: ['b/c.txt'] });
  eq('no change, no diff', diffSnapshots(before, before), { added: [], changed: [], removed: [] });
}

// ---- model references inside the folder
{
  const io = new MemoryFolder();
  await io.write('assets/car/textures/paint.png', png);
  await io.write('assets/car/flat.png', png);
  const resolve = folderResolver(io, 'assets/car');
  eq('relative paths resolve from the model\'s folder', new Uint8Array(await resolve('textures/paint.png')).length, png.length);
  eq('...or by file name next to it', new Uint8Array(await resolve('elsewhere/flat.png')).length, png.length);
}

// ---- not a project
{
  let message = '';
  try {
    await loadProjectFolder(new MemoryFolder());
  } catch (err) {
    message = (err as Error).message;
  }
  check('a folder without project.json is refused', message.includes('project.json'), message);
  // Scene files are plain scenes: an empty project needs at least one.
  const io = new MemoryFolder();
  await io.write('project.json', JSON.stringify({ format: 'messier-project-folder', version: 1, name: 'Empty' }));
  try {
    await loadProjectFolder(io);
    message = '';
  } catch (err) {
    message = (err as Error).message;
  }
  check('a project with no scenes is refused', message.includes('no scenes'), message);
  void ProjectResources;
}

// ---- script types for code editors
{
  const io = new MemoryFolder();
  eq('types and a tsconfig.json are added', await writeTypeFiles(io, 'v1'), [TYPES_PATH, TSCONFIG_PATH]);
  eq('the same types again: nothing to write', await writeTypeFiles(io, 'v1'), []);
  await io.write(TSCONFIG_PATH, '{ "mine": true }');
  eq('another version replaces the types but keeps the user\'s tsconfig.json', await writeTypeFiles(io, 'v2'), [TYPES_PATH]);
  eq('...which is untouched', new TextDecoder().decode(await io.read(TSCONFIG_PATH)), '{ "mine": true }');
  const config = JSON.parse(TSCONFIG_TEXT);
  check('the tsconfig checks the scripts against the types', config.include.includes('scripts/**/*.ts') && config.include.includes(TYPES_PATH) && config.compilerOptions.noEmit);
  eq('the dot folder isn\'t part of the project', await listFiles(io), [TSCONFIG_PATH]);
}
