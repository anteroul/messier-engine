import type { GameObject } from '../scene';
import type { Asset } from '../project';
import type { AudioClip } from '../audioClip';
import { Texture } from '../material';
import { tagAssetResources } from '../serialize';
import { loadAudioClip } from './audio';
import { loadGLTF } from './gltf';
import { loadOBJ } from './obj';
import { fileResolver, mimeFromName, recordingResolver, urlResolver, type MemoryFile, type ResourceResolver } from './resources';

export { loadGLTF } from './gltf';
export { loadOBJ } from './obj';
export * from './resources';
export * from './audio';

export const MODEL_EXTENSIONS = ['glb', 'gltf', 'obj'];
const extOf = (name: string) => name.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
const baseName = (name: string) => decodeURIComponent(name.split('?')[0].split('/').pop() ?? name).replace(/\.[^.]+$/, '');

/** Image files that can be a project asset of their own (a sky panorama). */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'];

export const isImageFile = (name: string) => IMAGE_EXTENSIONS.includes(extOf(name));

/** Decodes an image file into a texture named after the file. */
export async function loadImageTexture(fileName: string, data: ArrayBuffer): Promise<Texture> {
  return Texture.fromBlob(new Blob([data], { type: mimeFromName(fileName) }), baseName(fileName));
}

/** Loads an image file and captures it as a project asset (one file; scenes refer to its texture as index 0). */
export async function loadImageAsset(fileName: string, data: ArrayBuffer, id = newAssetId()): Promise<{ texture: Texture; asset: Asset }> {
  const bytes = new Uint8Array(data.slice(0));
  const texture = await loadImageTexture(fileName, data);
  texture.ref = { asset: id, index: 0 };
  return { texture, asset: { id, name: baseName(fileName), files: [{ name: fileName, bytes }] } };
}

/** Loads a model file that is already in memory. The extension of `fileName` picks the loader. */
export async function loadModelFromBytes(fileName: string, data: ArrayBuffer, resolve: ResourceResolver): Promise<GameObject> {
  const ext = extOf(fileName);
  if (ext === 'obj') return loadOBJ(new TextDecoder().decode(data), baseName(fileName), resolve);
  if (ext === 'glb' || ext === 'gltf') return loadGLTF(data, baseName(fileName), resolve);
  throw new Error(`Unsupported model format ".${ext}"`);
}

/** Loads a .glb / .gltf / .obj from a URL. Companion files are fetched relative to it. */
export async function loadModelFromURL(url: string): Promise<GameObject> {
  return (await loadModelAssetFromURL(url)).model;
}

/**
 * Loads every model among `files`. Other files (.bin, .mtl, textures) are used
 * to resolve references, so select/drop a model together with its companions.
 */
export async function loadModelsFromFiles(files: File[]): Promise<GameObject[]> {
  return (await loadModelAssetsFromFiles(files)).map((r) => r.model);
}

export interface LoadedAsset {
  /** The model, with its meshes and textures tagged with refs into `asset`. */
  model: GameObject;
  /** The model file plus exactly the companion files the loader read. */
  asset: Asset;
}

let assetCounter = 0;

/** A short id that is unique enough within a project. Doesn't need a secure context like crypto.randomUUID. */
export function newAssetId(): string {
  return `${Date.now().toString(36)}${(assetCounter++).toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Loads a model and captures it as a project asset, so a saved scene can reference its meshes and textures. */
export async function loadModelAsset(fileName: string, data: ArrayBuffer, resolve: ResourceResolver, id = newAssetId()): Promise<LoadedAsset> {
  const companions: MemoryFile[] = [];
  const bytes = new Uint8Array(data.slice(0));
  const model = await loadModelFromBytes(fileName, data, recordingResolver(resolve, companions));
  tagAssetResources(model, id);
  return { model, asset: { id, name: baseName(fileName), files: [{ name: fileName, bytes }, ...companions] } };
}

/** Loads a sound file and captures it as a project asset (one file; scenes refer to its clip as index 0). */
export async function loadAudioAsset(fileName: string, data: ArrayBuffer, id = newAssetId()): Promise<{ clip: AudioClip; asset: Asset }> {
  const bytes = new Uint8Array(data.slice(0));
  const clip = await loadAudioClip(fileName, data);
  clip.ref = { asset: id, index: 0 };
  return { clip, asset: { id, name: clip.name, files: [{ name: fileName, bytes }] } };
}

export async function loadModelAssetFromURL(url: string): Promise<LoadedAsset> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url} (${res.status})`);
  const fileName = decodeURIComponent(url.split('?')[0].split('/').pop() ?? url);
  return loadModelAsset(fileName, await res.arrayBuffer(), urlResolver(url));
}

export async function loadModelAssetsFromFiles(files: File[]): Promise<LoadedAsset[]> {
  const resolve = fileResolver(files);
  const models = files.filter((f) => MODEL_EXTENSIONS.includes(extOf(f.name)));
  if (models.length === 0) throw new Error('No .glb, .gltf or .obj file in selection');
  return Promise.all(models.map(async (f) => loadModelAsset(f.name, await f.arrayBuffer(), resolve)));
}
