import { crc32 as zlibCrc32, inflateRawSync } from 'node:zlib';
import { check, eq } from './harness';
import { GameObject, Scene } from '@root/src/engine/scene.ts';
import { Project, ProjectResources } from '@root/src/engine/project.ts';
import { serializeScene } from '@root/src/engine/serialize.ts';
import { SceneManager } from '@root/src/engine/sceneManager.ts';
import type { Engine } from '@root/src/engine/engine.ts';
import { createZip, crc32 } from '@root/src/editor/zip.ts';

function sceneData(...names: string[]) {
  const s = new Scene();
  for (const n of names) s.add(new GameObject(n));
  return serializeScene(s);
}

function project(): Project {
  const p = new Project();
  p.name = 'Game';
  p.scenes = [
    { id: 'a', name: 'Menu', data: sceneData('Title') },
    { id: 'b', name: 'Level', data: sceneData('Player') },
    { id: 'c', name: 'Test', data: sceneData('Junk') },
  ];
  p.startScene = 'a';
  return p;
}

// ---- build settings: order and inclusion, kept in the manifest
{
  const p = project();
  eq('every scene is in the build by default, in project order', p.buildList().map((e) => `${e.scene.name}:${e.enabled}`), ['Menu:true', 'Level:true', 'Test:true']);
  p.build.scenes = [
    { id: 'b', enabled: true },
    { id: 'gone', enabled: true },
    { id: 'c', enabled: false },
  ];
  eq('stored order first, unknown ids dropped, unlisted scenes appended', p.buildList().map((e) => `${e.scene.name}:${e.enabled}`), ['Level:true', 'Test:false', 'Menu:true']);
  eq('buildScenes() skips excluded ones', p.buildScenes().map((s) => s.name), ['Level', 'Menu']);
  p.build.title = 'My Game';
  const back = Project.decode(p.encode());
  eq('build settings survive encode/decode', back.build, p.build);
  const old = Project.fromManifest({ ...p.manifest(), build: undefined }, () => null);
  eq('projects without build settings get defaults', old.build, { title: '', scenes: [] });
  const bad = Project.fromManifest({ ...p.manifest(), build: { title: 3, scenes: [{ id: 'a', enabled: 'no' }, 'x', { enabled: false }] } }, () => null);
  eq('mistyped build settings are ignored', bad.build, { title: '', scenes: [{ id: 'a', enabled: true }] });
}

// ---- subset: what a built game ships
{
  const p = project();
  const withAsset = sceneData('Model');
  withAsset.objects[0].mesh = { asset: 'used', index: 0 };
  p.scenes[1].data = withAsset;
  p.scripts = [{ name: 'Spin', source: 'export default class Spin {}' }];
  p.assets = [
    { id: 'unused', name: 'a.obj', files: [{ name: 'a.obj', bytes: new Uint8Array([1]) }] },
    { id: 'used', name: 'b.obj', files: [{ name: 'b.obj', bytes: new Uint8Array([2, 3]) }] },
  ];
  const sub = p.subset([p.scenes[1], p.scenes[0]]);
  eq('only the given scenes, in that order', sub.scenes.map((s) => s.name), ['Level', 'Menu']);
  check('the first one starts', sub.startScene === 'b');
  eq('only the assets they use', sub.assets.map((a) => a.id), ['used']);
  eq('all scripts', sub.scripts.map((s) => s.name), ['Spin']);
  const back = Project.decode(sub.encode());
  check('subset encodes and decodes', back.scenes.length === 2 && back.assets[0]?.files[0].bytes.join() === '2,3');
  check('the original is untouched', p.scenes.length === 3 && p.assets.length === 2);
}

// ---- sceneManager: load by name or index, last load wins, replaced scenes are disposed
await (async () => {
  const p = project();
  const resources = new ProjectResources(p);
  const engine = { scene: new Scene(), setActiveScene(s: Scene) { this.scene = s; } } as unknown as Engine;
  const sm = new SceneManager();
  const warnings: string[] = [];
  sm.onWarning = (m) => warnings.push(m);

  eq('not attached: loading warns', await sm.loadScene(0), null);
  check('…with a message', warnings.length === 1 && /no game is running/.test(warnings[0]), warnings[0]);

  const first = engine.scene;
  sm.attach(engine, { names: p.scenes.map((s) => s.name), load: (i) => resources.instantiate(p.scenes[i], first.scripts) });
  check('names and count', sm.sceneCount === 3 && sm.sceneName(1) === 'Level' && sm.sceneName(5) === null && sm.activeSceneIndex === -1);

  const level = await sm.loadScene('Level');
  check('load by name makes it active', level !== null && engine.scene === level && level.findByName('Player') !== null);
  check('…and tracks the index', sm.activeSceneIndex === 1 && sm.activeSceneName === 'Level');
  check('scenes it did not load are left alone', first.root.children.length === 0 && sm.isLoading === false);
  check('the new scene shares the script library', level!.scripts === first.scripts);

  let loaded = -1;
  sm.sceneLoaded.connect((_s, i) => (loaded = i));
  const menu = await sm.loadScene(0);
  check('load by index', engine.scene === menu && loaded === 0);
  check('the replaced scene it loaded is disposed', level!.root.children.length === 0);

  eq('unknown name', await sm.loadScene('Nope'), null);
  eq('index out of range', await sm.loadScene(3), null);
  check('…warn and keep the scene', engine.scene === menu && warnings.length === 3 && /isn't in the build/.test(warnings[1]), warnings.join(' | '));

  const a = sm.loadScene('Level');
  const b = sm.loadScene('Test');
  check('overlapping loads are in progress', sm.isLoading);
  const [ra, rb] = await Promise.all([a, b]);
  check('the last load wins', ra === null && rb !== null && engine.scene === rb && sm.activeSceneName === 'Test');

  const pending = sm.loadScene('Menu');
  sm.detach();
  check('detach drops a load in progress', (await pending) === null && engine.scene === rb && sm.sceneCount === 0);
})();

// ---- zip: valid archive, deflated where it helps
await (async () => {
  const text = 'hello hello hello hello hello hello hello hello\n'.repeat(50);
  const bin = new Uint8Array([0, 1, 2, 3, 255]);
  const zip = Buffer.from(await createZip([{ name: 'index.html', data: text }, { name: 'dir/ä.bin', data: bin }], new Date(2026, 10, 14, 12, 30, 10)));
  eq('crc32 matches zlib', crc32(bin), zlibCrc32(bin));

  const end = zip.length - 22;
  check('end of central directory', zip.readUInt32LE(end) === 0x06054b50 && zip.readUInt16LE(end + 10) === 2);
  const files: Record<string, { method: number; data: Buffer; crc: number }> = {};
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < 2; i++) {
    check(`central header ${i}`, zip.readUInt32LE(at) === 0x02014b50);
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    check(`local header ${name}`, zip.readUInt32LE(local) === 0x04034b50 && zip.readUInt16LE(local + 8) === method);
    const start = local + 30 + zip.readUInt16LE(local + 26);
    const raw = zip.subarray(start, start + size);
    files[name] = { method, crc: zip.readUInt32LE(at + 16), data: method === 8 ? inflateRawSync(raw) : Buffer.from(raw) };
    at += 46 + nameLen;
  }
  check('text is deflated and round-trips', files['index.html']?.method === 8 && files['index.html'].data.toString('utf8') === text);
  check('tiny binary is stored (deflate would grow it), UTF-8 name', files['dir/ä.bin']?.method === 0 && files['dir/ä.bin'].data.equals(Buffer.from(bin)));
  check('CRCs of the uncompressed data', files['index.html']?.crc === zlibCrc32(text));
  check('DOS date and time', zip.readUInt16LE(12) === ((2026 - 1980) << 9 | 11 << 5 | 14) && zip.readUInt16LE(10) === (12 << 11 | 30 << 5 | 5));
})();
