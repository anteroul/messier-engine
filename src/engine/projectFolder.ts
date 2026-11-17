import { Project, ProjectResources, type Asset, type ProjectScene } from './project';
import { checkSceneData, tagAssetResources, type SceneData } from './serialize';
import { isObject } from './data';
import { MODEL_EXTENSIONS, isAudioFile, isImageFile, loadModelFromBytes, newAssetId, recordingResolver, type MemoryFile, type ResourceResolver } from './loaders';

// A project on disk, Godot/Unity style:
//   project.json             name, build settings, start scene
//   scenes/<Name>.messier    one scene each (SceneData as JSON)
//   scripts/<Name>.ts        one script each
//   assets/**                imported files, each with a <file>.meta holding its stable id
// Scenes refer to assets by that id ({ asset: id, index }), so a file moved or renamed together with its .meta keeps
// its references. In memory it is the same Project as always (scene ids are their paths, asset ids their meta ids),
// so builds and the player don't know about folders. Paths use '/' and are relative to the project folder.

export const PROJECT_FOLDER_FORMAT = 'messier-project-folder';
export const PROJECT_FOLDER_VERSION = 1;
export const PROJECT_MANIFEST = 'project.json';
export const SCENES_DIR = 'scenes';
export const SCRIPTS_DIR = 'scripts';
export const ASSETS_DIR = 'assets';
export const SCENE_EXTENSION = '.messier';
export const SCRIPT_EXTENSION = '.ts';
export const META_EXTENSION = '.meta';
const META_FORMAT = 1;

/** File access the folder format needs. Paths are relative to the project folder. */
export interface FolderIO {
  /** Entries of a directory ('' = the project folder); an empty list when it doesn't exist. */
  list(dir: string): Promise<{ name: string; kind: 'file' | 'directory' }[]>;
  read(path: string): Promise<Uint8Array<ArrayBuffer>>;
  /** Creates missing directories. */
  write(path: string, data: Uint8Array | string): Promise<void>;
  /** Removes a file or a directory with its contents; nothing happens when it doesn't exist. */
  remove(path: string): Promise<void>;
  /** Size and modification time, or null when there is no such file. */
  stat(path: string): Promise<{ size: number; modified: number } | null>;
}

export type AssetKind = 'model' | 'image' | 'sound' | 'other';

export function assetKind(path: string): AssetKind {
  const ext = extension(path);
  if (MODEL_EXTENSIONS.includes(ext)) return 'model';
  if (isImageFile(path)) return 'image';
  if (isAudioFile(path)) return 'sound';
  return 'other';
}

// ---- paths

export const joinPath = (...parts: string[]) => normalizePath(parts.filter(Boolean).join('/'));
export const dirName = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
export const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
/** File name without its extension. */
export const fileStem = (path: string) => fileName(path).replace(/\.[^.]*$/, '');
const extension = (path: string) => (fileName(path).match(/\.([^.]*)$/)?.[1] ?? '').toLowerCase();

/** Resolves '.' and '..' segments and repeated slashes. */
export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/** A name that works as a file name on every system. */
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^\.+/, '').trim() || 'Untitled';
}

export const scenePath = (name: string) => `${SCENES_DIR}/${safeFileName(name)}${SCENE_EXTENSION}`;
export const scriptPath = (name: string) => `${SCRIPTS_DIR}/${safeFileName(name)}${SCRIPT_EXTENSION}`;
export const metaPath = (assetPath: string) => assetPath + META_EXTENSION;
export const isMetaFile = (path: string) => path.endsWith(META_EXTENSION);
export const isScenePath = (path: string) => path.startsWith(`${SCENES_DIR}/`) && path.endsWith(SCENE_EXTENSION) && !path.slice(SCENES_DIR.length + 1).includes('/');
export const isScriptPath = (path: string) => path.startsWith(`${SCRIPTS_DIR}/`) && path.endsWith(SCRIPT_EXTENSION) && !path.slice(SCRIPTS_DIR.length + 1).includes('/');
export const isAssetPath = (path: string) => path.startsWith(`${ASSETS_DIR}/`) && !isMetaFile(path);

/** Every file under `dir`, recursively, sorted; dot files are skipped. */
export async function listFiles(io: FolderIO, dir = ''): Promise<string[]> {
  const out: string[] = [];
  const entries = (await io.list(dir)).filter((e) => !e.name.startsWith('.')).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const path = joinPath(dir, e.name);
    if (e.kind === 'directory') out.push(...(await listFiles(io, path)));
    else out.push(path);
  }
  return out;
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

// ---- text forms

export function sceneText(data: SceneData): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

export function manifestText(project: Project): string {
  return `${JSON.stringify(
    { format: PROJECT_FOLDER_FORMAT, version: PROJECT_FOLDER_VERSION, name: project.name, startScene: project.startScene, build: project.build },
    null,
    2,
  )}\n`;
}

export function metaText(id: string): string {
  return `${JSON.stringify({ id, format: META_FORMAT }, null, 2)}\n`;
}

/** The id in an asset's .meta file, or null when it has none (or it can't be read). */
export async function readMeta(io: FolderIO, assetPath: string): Promise<string | null> {
  try {
    const json: unknown = JSON.parse(text(await io.read(metaPath(assetPath))));
    return isObject(json) && typeof json.id === 'string' && json.id ? json.id : null;
  } catch {
    return null;
  }
}

// ---- loading

export interface LoadedFolder {
  project: Project;
  /** The project's assets, loaded. */
  resources: ProjectResources;
  warnings: string[];
}

/** Reads a project folder. Asset files without a .meta get one (written to the folder). */
export async function loadProjectFolder(io: FolderIO): Promise<LoadedFolder> {
  const warnings: string[] = [];
  let manifest: unknown;
  try {
    manifest = JSON.parse(text(await io.read(PROJECT_MANIFEST)));
  } catch {
    throw new Error(`There's no ${PROJECT_MANIFEST} in this folder: it isn't a Messier project`);
  }
  if (!isObject(manifest) || manifest.format !== PROJECT_FOLDER_FORMAT) throw new Error(`${PROJECT_MANIFEST} isn't a Messier project manifest`);
  if (typeof manifest.version === 'number' && manifest.version > PROJECT_FOLDER_VERSION) {
    throw new Error(`The project was saved by a newer Messier (project folder format ${manifest.version})`);
  }
  const project = new Project();
  if (typeof manifest.name === 'string') project.name = manifest.name;

  for (const path of await listFiles(io, SCENES_DIR)) {
    if (!isScenePath(path)) continue;
    try {
      project.scenes.push(await readScene(io, path));
    } catch (err) {
      warnings.push(`${path}: ${(err as Error).message}`);
    }
  }
  if (project.scenes.length === 0) throw new Error('The project has no scenes');
  project.startScene = typeof manifest.startScene === 'string' && project.getScene(manifest.startScene) ? manifest.startScene : project.scenes[0].id;
  if (isObject(manifest.build)) {
    if (typeof manifest.build.title === 'string') project.build.title = manifest.build.title;
    for (const e of Array.isArray(manifest.build.scenes) ? manifest.build.scenes : []) {
      if (isObject(e) && typeof e.id === 'string') project.build.scenes.push({ id: e.id, enabled: e.enabled !== false });
    }
  }
  for (const path of await listFiles(io, SCRIPTS_DIR)) {
    if (isScriptPath(path)) project.scripts.push({ name: fileStem(path), source: text(await io.read(path)) });
  }

  const resources = new ProjectResources(project);
  const files = (await listFiles(io, ASSETS_DIR)).filter((p) => !isMetaFile(p));
  // A file copied together with its .meta shares its original's id. The original is the one with the older .meta:
  // load it first so it keeps the id, and the copy gets a new one.
  const age = new Map<string, number>();
  for (const path of files) age.set(path, (await io.stat(metaPath(path)))?.modified ?? Infinity);
  const ordered = [...files].sort((a, b) => age.get(a)! - age.get(b)!);
  for (const path of ordered) await importAssetFile(io, path, project, resources, warnings);
  // Listed in folder order, whatever order they loaded in.
  const order = new Map(files.map((p, i) => [p.slice(ASSETS_DIR.length + 1), i]));
  project.assets.sort((a, b) => order.get(a.path!)! - order.get(b.path!)!);
  return { project, resources, warnings };
}

export async function readScene(io: FolderIO, path: string): Promise<ProjectScene> {
  const data: unknown = JSON.parse(text(await io.read(path)));
  checkSceneData(data);
  return { id: path, name: fileStem(path), data };
}

/**
 * Adds (or replaces) the asset for one file under assets/: gives it a .meta if it has none, reads it, and loads it
 * into `resources`. A model's companion files (.bin, .mtl, textures) are found by loading it, relative to its own
 * directory. Returns the asset.
 */
export async function importAssetFile(io: FolderIO, path: string, project: Project, resources: ProjectResources, warnings: string[] = []): Promise<Asset> {
  const relative = path.slice(ASSETS_DIR.length + 1);
  let id = await readMeta(io, path);
  const clash = id ? project.getAsset(id) : null;
  if (clash && clash.path !== relative) {
    // A copied file brought its original's .meta along: the copy is a different asset.
    warnings.push(`${path} had the same id as ${ASSETS_DIR}/${clash.path}; it got a new one`);
    id = null;
  }
  if (!id) {
    id = newAssetId();
    await io.write(metaPath(path), metaText(id));
  }
  const bytes = await io.read(path);
  const asset: Asset = { id, name: fileStem(path), path: relative, files: [{ name: fileName(path), bytes }] };
  const existing = project.assets.findIndex((a) => a.id === id || a.path === relative);
  if (existing >= 0) project.assets.splice(existing, 1, asset);
  else project.assets.push(asset);

  const kind = assetKind(path);
  if (kind === 'model') {
    resources.forget(id);
    const companions: MemoryFile[] = [];
    try {
      const model = await loadModelFromBytes(asset.files[0].name, bytes.slice().buffer, recordingResolver(folderResolver(io, dirName(path)), companions));
      resources.register(id, tagAssetResources(model, id), model);
    } catch (err) {
      warnings.push(`Could not load ${path}: ${(err as Error).message}`);
    }
    asset.files.push(...companions);
  } else if (kind === 'image' || kind === 'sound') {
    await resources.load(id, warnings);
  }
  return asset;
}

/** Resolves a model's relative references inside the folder; falls back to the file name in the model's directory. */
export function folderResolver(io: FolderIO, dir: string): ResourceResolver {
  return async (uri) => {
    if (uri.startsWith('data:')) return (await fetch(uri)).arrayBuffer();
    const rel = decodeURIComponent(uri.split('?')[0]);
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = await io.read(joinPath(dir, rel));
    } catch {
      bytes = await io.read(joinPath(dir, fileName(normalizePath(rel))));
    }
    return bytes.slice().buffer;
  };
}

// ---- writing

/**
 * Writes `project` as a folder and returns it as loaded from there: scene ids become their paths, and assets get
 * paths under assets/ (a model with companion files in a directory of its own). Asset ids are kept, so scene
 * references stay valid.
 */
export async function writeProjectFolder(io: FolderIO, project: Project): Promise<Project> {
  const out = new Project();
  out.name = project.name;
  const sceneIds = new Map<string, string>();
  const usedScenes = new Set<string>();
  for (const s of project.scenes) {
    let path = isScenePath(s.id) ? s.id : scenePath(s.name);
    for (let i = 2; usedScenes.has(path.toLowerCase()); i++) path = scenePath(`${s.name} ${i}`);
    usedScenes.add(path.toLowerCase());
    sceneIds.set(s.id, path);
    out.scenes.push({ id: path, name: fileStem(path), data: s.data });
  }
  out.startScene = sceneIds.get(project.startScene) ?? out.scenes[0]?.id ?? '';
  out.build = {
    title: project.build.title,
    scenes: project.build.scenes.filter((e) => sceneIds.has(e.id)).map((e) => ({ id: sceneIds.get(e.id)!, enabled: e.enabled })),
  };
  out.scripts = project.scripts.map((s) => ({ ...s }));

  const usedAssets = new Set<string>();
  const unique = (path: string) => {
    let p = path;
    for (let i = 2; usedAssets.has(p.toLowerCase()); i++) p = path.replace(/(\.[^./]*)?$/, (ext) => ` ${i}${ext}`);
    usedAssets.add(p.toLowerCase());
    return p;
  };
  for (const a of project.assets) {
    const [main, ...companions] = a.files;
    let path = a.path;
    if (!path) path = companions.length ? `${safeFileName(a.name)}/${safeFileName(main.name)}` : safeFileName(main.name);
    path = unique(normalizePath(path));
    const dir = dirName(path);
    out.assets.push({ ...a, path, files: a.files.map((f) => ({ ...f })) });
    await io.write(joinPath(ASSETS_DIR, path), main.bytes);
    await io.write(metaPath(joinPath(ASSETS_DIR, path)), metaText(a.id));
    for (const [i, f] of companions.entries()) {
      const p = joinPath(ASSETS_DIR, dir, f.name);
      if (usedAssets.has(p.slice(ASSETS_DIR.length + 1).toLowerCase())) continue;
      usedAssets.add(p.slice(ASSETS_DIR.length + 1).toLowerCase());
      await io.write(p, f.bytes);
      // Companions are assets too (an image can be used on its own); their ids just need to be stable.
      await io.write(metaPath(p), metaText(`${a.id}-${i + 1}`));
    }
  }

  await io.write(PROJECT_MANIFEST, manifestText(out));
  for (const s of out.scenes) await io.write(s.id, sceneText(s.data));
  for (const s of out.scripts) await io.write(scriptPath(s.name), s.source);
  return out;
}

// ---- change detection

/** Path → "size:modified" for every file in the folder. */
export type FolderSnapshot = Map<string, string>;

export async function snapshotFolder(io: FolderIO): Promise<FolderSnapshot> {
  const snap: FolderSnapshot = new Map();
  for (const path of await listFiles(io)) {
    const st = await io.stat(path);
    if (st) snap.set(path, `${st.size}:${st.modified}`);
  }
  return snap;
}

export function diffSnapshots(before: FolderSnapshot, after: FolderSnapshot): { added: string[]; changed: string[]; removed: string[] } {
  const added: string[] = [], changed: string[] = [], removed: string[] = [];
  for (const [path, sig] of after) {
    const old = before.get(path);
    if (old === undefined) added.push(path);
    else if (old !== sig) changed.push(path);
  }
  for (const path of before.keys()) if (!after.has(path)) removed.push(path);
  return { added, changed, removed };
}

// ---- in memory

/** A FolderIO kept in memory: for tests, and to zip a project. */
export class MemoryFolder implements FolderIO {
  readonly files = new Map<string, { bytes: Uint8Array<ArrayBuffer>; modified: number }>();
  private clock = 0;

  async list(dir: string): Promise<{ name: string; kind: 'file' | 'directory' }[]> {
    const prefix = dir ? `${normalizePath(dir)}/` : '';
    const seen = new Map<string, 'file' | 'directory'>();
    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) seen.set(rest, 'file');
      else seen.set(rest.slice(0, slash), 'directory');
    }
    return [...seen].map(([name, kind]) => ({ name, kind }));
  }

  async read(path: string): Promise<Uint8Array<ArrayBuffer>> {
    const f = this.files.get(normalizePath(path));
    if (!f) throw new Error(`${path} not found`);
    return f.bytes.slice();
  }

  async write(path: string, data: Uint8Array | string): Promise<void> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
    this.files.set(normalizePath(path), { bytes, modified: ++this.clock });
  }

  async remove(path: string): Promise<void> {
    const p = normalizePath(path);
    for (const key of [...this.files.keys()]) if (key === p || key.startsWith(`${p}/`)) this.files.delete(key);
  }

  async stat(path: string): Promise<{ size: number; modified: number } | null> {
    const f = this.files.get(normalizePath(path));
    return f ? { size: f.bytes.byteLength, modified: f.modified } : null;
  }
}
