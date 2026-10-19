import type { GameObject } from '../scene';
import { loadGLTF } from './gltf';
import { loadOBJ } from './obj';
import { fileResolver, urlResolver } from './resources';

export { loadGLTF } from './gltf';
export { loadOBJ } from './obj';
export * from './resources';

export const MODEL_EXTENSIONS = ['glb', 'gltf', 'obj'];

const extOf = (name: string) => name.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
const baseName = (name: string) => decodeURIComponent(name.split('?')[0].split('/').pop() ?? name).replace(/\.[^.]+$/, '');

/** Loads a .glb / .gltf / .obj from a URL. Companion files are fetched relative to it. */
export async function loadModelFromURL(url: string): Promise<GameObject> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url} (${res.status})`);
  const ext = extOf(url);
  const resolve = urlResolver(url);
  if (ext === 'obj') return loadOBJ(await res.text(), baseName(url), resolve);
  if (ext === 'glb' || ext === 'gltf') return loadGLTF(await res.arrayBuffer(), baseName(url), resolve);
  throw new Error(`Unsupported model format ".${ext}"`);
}

/**
 * Loads every model among `files`. Other files (.bin, .mtl, textures) are used
 * to resolve references, so select/drop a model together with its companions.
 */
export async function loadModelsFromFiles(files: File[]): Promise<GameObject[]> {
  const resolve = fileResolver(files);
  const models = files.filter((f) => MODEL_EXTENSIONS.includes(extOf(f.name)));
  if (models.length === 0) throw new Error('No .glb, .gltf or .obj file in selection');
  return Promise.all(
    models.map(async (f) => {
      const ext = extOf(f.name);
      if (ext === 'obj') return loadOBJ(await f.text(), baseName(f.name), resolve);
      return loadGLTF(await f.arrayBuffer(), baseName(f.name), resolve);
    }),
  );
}
