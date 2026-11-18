import type { Mesh, ResourceRef } from './mesh';
import type { Texture } from './material';
import { Scene, type GameObject, type PrefabSource } from './scene';
import type { ScriptLibrary } from './scripting';
import { buildPrimitive } from './primitives';
import { bytesResolver, isAudioFile, isImageFile, loadAudioClip, loadImageTexture, loadModelFromBytes, type MemoryFile } from './loaders';
import { AudioClip, type ClipRef } from './audioClip';
import { applySceneData, collectAssetIds, instantiatePrefab, sceneAssetIds, tagAssetResources, upgradeSceneData, type SceneData, type SceneResources } from './serialize';
import { isPrefabFile, readPrefab, type PrefabData } from './prefab';
import { isObject } from './data';

// A project is a set of scenes plus the scripts and imported assets they share. On disk it is a folder (see
// projectFolder.ts). Packed, as a built game carries it (and as single-file projects were saved before project
// folders), it is one binary file laid out like a GLB:
//   header:  magic "MSPJ" | container version | total length   (3 x u32 LE)
//   chunk 0: length | "JSON" | manifest (UTF-8, space padded to 4 bytes)
//   chunk 1: length | "BIN\0" | asset file bytes, each 4-byte aligned (optional)
// The manifest holds every scene's SceneData, the script sources, the build
// settings, and for each asset file its { offset, length } in the BIN chunk.

export const PROJECT_FORMAT = 'messier-project';
export const PROJECT_VERSION = 1;

const MAGIC = 0x4a50534d; // "MSPJ"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/**
 * An imported file: a model (the model file first, then the companion files (.bin, .mtl, textures) it read), a
 * sound or an image (one file). The first file's extension tells which.
 */
export interface Asset {
  id: string;
  name: string;
  files: MemoryFile[];
  /** Where it lives under assets/ in a project folder (set by the folder format; not part of the packed form). */
  path?: string;
}

export interface ProjectScene {
  id: string;
  name: string;
  data: SceneData;
}

export interface ScriptSource {
  name: string;
  source: string;
}

/** What File → Build puts in a game: the scenes in build order (the first one starts) and the page title. */
export interface BuildSettings {
  /** Defaults to the project name. */
  title: string;
  /** Scenes not listed are appended, included. Ids of deleted scenes are ignored. */
  scenes: { id: string; enabled: boolean }[];
}

interface AssetEntry {
  id: string;
  name: string;
  /** Its place under assets/ in a project folder, so a browser copy saved to a folder keeps the layout. */
  path?: string;
  files: { name: string; offset?: number; length: number }[];
}

/** The JSON part of a project. Asset files carry offsets into the BIN chunk when encoded. */
export interface ProjectManifest {
  format: typeof PROJECT_FORMAT;
  version: number;
  name: string;
  startScene: string;
  scenes: ProjectScene[];
  scripts: ScriptSource[];
  build: BuildSettings;
  assets: AssetEntry[];
}

export class Project {
  name = 'Untitled';
  scenes: ProjectScene[] = [];
  startScene = '';
  scripts: ScriptSource[] = [];
  build: BuildSettings = { title: '', scenes: [] };
  /**
   * Imported files. Kept in memory even when no scene uses them anymore (undo
   * can bring the objects back); only referenced assets are written out.
   */
  assets: Asset[] = [];

  getScene(id: string): ProjectScene | null {
    return this.scenes.find((s) => s.id === id) ?? null;
  }

  getAsset(id: string): Asset | null {
    return this.assets.find((a) => a.id === id) ?? null;
  }

  /** Every scene in build order, with whether the build includes it. */
  buildList(): { scene: ProjectScene; enabled: boolean }[] {
    const list: { scene: ProjectScene; enabled: boolean }[] = [];
    for (const { id, enabled } of this.build.scenes) {
      const scene = this.getScene(id);
      if (scene && !list.some((e) => e.scene === scene)) list.push({ scene, enabled });
    }
    for (const scene of this.scenes) if (!list.some((e) => e.scene === scene)) list.push({ scene, enabled: true });
    return list;
  }

  /** The scenes a build includes, in order. Their indices are the ones `sceneManager.loadScene()` takes. */
  buildScenes(): ProjectScene[] {
    return this.buildList().filter((e) => e.enabled).map((e) => e.scene);
  }

  /**
   * A copy holding only `scenes` (in that order, the first one starting) and the assets they use: what a built
   * game ships. Scene data and asset files are shared, not copied.
   */
  subset(scenes: ProjectScene[]): Project {
    const p = new Project();
    p.name = this.name;
    p.scenes = scenes.map((s) => ({ ...s }));
    p.startScene = p.scenes[0]?.id ?? '';
    p.scripts = this.scripts.map((s) => ({ ...s }));
    p.build = { title: this.build.title, scenes: p.scenes.map((s) => ({ id: s.id, enabled: true })) };
    const ids = this.usedAssetIds(p.scenes);
    p.assets = this.assets.filter((a) => ids.has(a.id));
    return p;
  }

  /** Assets used by at least one scene, and every prefab (scripts instantiate them by name), in project order. */
  referencedAssets(): Asset[] {
    const ids = this.usedAssetIds(this.scenes);
    return this.assets.filter((a) => ids.has(a.id));
  }

  /** Ids of the assets `scenes` use, every prefab, and what those prefabs use. */
  usedAssetIds(scenes: readonly ProjectScene[]): Set<string> {
    const ids = new Set<string>();
    for (const s of scenes) sceneAssetIds(s.data, ids);
    for (const a of this.assets) if (isPrefabAsset(a)) ids.add(a.id);
    return this.withDependencies(ids);
  }

  /** `ids` plus the assets the prefabs among them use, recursively (in place). */
  withDependencies(ids: Set<string>): Set<string> {
    const done = new Set<string>();
    for (let more = true; more; ) {
      more = false;
      for (const id of [...ids]) {
        if (done.has(id)) continue;
        done.add(id);
        const data = this.prefabData(id);
        if (data) {
          const before = ids.size;
          collectAssetIds(data.root, ids);
          more ||= ids.size > before;
        }
      }
    }
    return ids;
  }

  /** The prefab of a prefab asset (null for other assets, and when the file can't be read). */
  prefabData(id: string): PrefabData | null {
    const a = this.getAsset(id);
    if (!a || !isPrefabAsset(a)) return null;
    try {
      return readPrefab(a.files[0].bytes);
    } catch {
      return null;
    }
  }

  /** A prefab asset by id, name or path under assets/ (with or without the extension). */
  findPrefab(key: string): Asset | null {
    const prefabs = this.assets.filter(isPrefabAsset);
    const strip = (p: string) => p.replace(/\.prefab$/i, '');
    return (
      prefabs.find((a) => a.id === key) ??
      prefabs.find((a) => a.name === key) ??
      prefabs.find((a) => !!a.path && (a.path === key || strip(a.path) === key)) ??
      null
    );
  }

  /** The JSON part without file offsets. Cheap to compare for change detection. */
  manifest(): ProjectManifest {
    return {
      format: PROJECT_FORMAT,
      version: PROJECT_VERSION,
      name: this.name,
      startScene: this.startScene,
      scenes: this.scenes,
      scripts: this.scripts,
      build: this.build,
      assets: this.referencedAssets().map((a) => ({
        id: a.id,
        name: a.name,
        ...(a.path ? { path: a.path } : {}),
        files: a.files.map((f) => ({ name: f.name, length: f.bytes.byteLength })),
      })),
    };
  }

  encode(): Uint8Array<ArrayBuffer> {
    const manifest = this.manifest();
    const assets = this.referencedAssets();
    let binLength = 0;
    manifest.assets.forEach((entry, i) =>
      entry.files.forEach((f, j) => {
        f.offset = binLength;
        binLength += align4(assets[i].files[j].bytes.byteLength);
      }),
    );
    const json = new TextEncoder().encode(JSON.stringify(manifest));
    const jsonLength = align4(json.byteLength);
    const total = 12 + 8 + jsonLength + (binLength ? 8 + binLength : 0);
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    view.setUint32(0, MAGIC, true);
    view.setUint32(4, PROJECT_VERSION, true);
    view.setUint32(8, total, true);
    view.setUint32(12, jsonLength, true);
    view.setUint32(16, CHUNK_JSON, true);
    out.set(json, 20);
    out.fill(0x20, 20 + json.byteLength, 20 + jsonLength);
    if (binLength) {
      const bin = 20 + jsonLength;
      view.setUint32(bin, binLength, true);
      view.setUint32(bin + 4, CHUNK_BIN, true);
      manifest.assets.forEach((entry, i) => entry.files.forEach((f, j) => out.set(assets[i].files[j].bytes, bin + 8 + f.offset!)));
    }
    return out;
  }

  static decode(data: ArrayBuffer | Uint8Array<ArrayBuffer>): Project {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 20 || view.getUint32(0, true) !== MAGIC) throw new Error('Not a Messier project file');
    const version = view.getUint32(4, true);
    if (version > PROJECT_VERSION) throw new Error(`Project was saved by a newer Messier (file format ${version})`);
    const length = Math.min(view.getUint32(8, true), bytes.byteLength);
    let json: unknown = null;
    let bin: Uint8Array<ArrayBuffer> | null = null;
    for (let offset = 12; offset + 8 <= length; ) {
      const chunkLength = view.getUint32(offset, true);
      const type = view.getUint32(offset + 4, true);
      const start = offset + 8;
      if (start + chunkLength > length) throw new Error('Project file is truncated');
      if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(bytes.subarray(start, start + chunkLength)));
      else if (type === CHUNK_BIN && !bin) bin = bytes.subarray(start, start + chunkLength);
      offset = start + chunkLength;
    }
    return Project.fromManifest(json, (_asset, file) => {
      if (!bin || file.offset === undefined || file.offset + file.length > bin.byteLength) return null;
      return bin.slice(file.offset, file.offset + file.length);
    });
  }

  /**
   * Builds a project from its manifest. `fileBytes` supplies each asset file's
   * contents (from the BIN chunk, or from autosave storage); assets with a
   * missing file are dropped, and their scenes load with warnings.
   */
  static fromManifest(json: unknown, fileBytes: (asset: AssetEntry, file: AssetEntry['files'][number]) => Uint8Array<ArrayBuffer> | null): Project {
    if (!isObject(json) || json.format !== PROJECT_FORMAT) throw new Error('Not a Messier project');
    if (typeof json.version !== 'number' || json.version > PROJECT_VERSION) {
      throw new Error(`Project was saved by a newer Messier (project format ${String(json.version)})`);
    }
    const p = new Project();
    if (typeof json.name === 'string') p.name = json.name;
    for (const s of Array.isArray(json.scenes) ? json.scenes : []) {
      if (!isObject(s) || typeof s.id !== 'string' || p.getScene(s.id)) continue;
      p.scenes.push({ id: s.id, name: typeof s.name === 'string' ? s.name : 'Scene', data: upgradeSceneData(s.data) });
    }
    if (p.scenes.length === 0) throw new Error('Project has no scenes');
    p.startScene = typeof json.startScene === 'string' && p.getScene(json.startScene) ? json.startScene : p.scenes[0].id;
    for (const s of Array.isArray(json.scripts) ? json.scripts : []) {
      if (isObject(s) && typeof s.name === 'string' && typeof s.source === 'string') p.scripts.push({ name: s.name, source: s.source });
    }
    if (isObject(json.build)) {
      if (typeof json.build.title === 'string') p.build.title = json.build.title;
      for (const e of Array.isArray(json.build.scenes) ? json.build.scenes : []) {
        if (isObject(e) && typeof e.id === 'string') p.build.scenes.push({ id: e.id, enabled: e.enabled !== false });
      }
    }
    for (const a of Array.isArray(json.assets) ? json.assets : []) {
      if (!isObject(a) || typeof a.id !== 'string' || !Array.isArray(a.files)) continue;
      const entry: AssetEntry = { id: a.id, name: typeof a.name === 'string' ? a.name : a.id, files: [] };
      const files: MemoryFile[] = [];
      for (const f of a.files) {
        if (!isObject(f) || typeof f.name !== 'string' || typeof f.length !== 'number') continue;
        const file = { name: f.name, length: f.length, offset: typeof f.offset === 'number' ? f.offset : undefined };
        const bytes = fileBytes(entry, file);
        if (!bytes) {
          files.length = 0;
          break;
        }
        files.push({ name: f.name, bytes });
      }
      if (files.length) p.assets.push({ id: entry.id, name: entry.name, ...(typeof a.path === 'string' && a.path ? { path: a.path } : {}), files });
    }
    return p;
  }
}

const align4 = (n: number) => (n + 3) & ~3;

export const isPrefabAsset = (a: Asset) => isPrefabFile(a.files[0]?.name ?? '');

interface LoadedResources {
  meshes: Mesh[];
  textures: Texture[];
  /** A model asset's loaded hierarchy (null for images). */
  model: GameObject | null;
}

/**
 * Resolves scene refs for one project: rebuilds primitives and synthesized
 * sounds, and loads each imported asset once, sharing its meshes, textures and
 * clips across scene loads. Also the prefab source of the scenes it loads.
 */
export class ProjectResources implements SceneResources, PrefabSource {
  private readonly assets = new Map<string, LoadedResources | null>();
  private readonly clips = new Map<string, AudioClip | null>();
  private readonly primitives = new Map<string, Mesh>();

  constructor(readonly project: Project) {}

  /**
   * Loads the assets `data` references that aren't loaded yet, and those of every prefab (a script may instantiate
   * any of them). Failures become warnings.
   */
  async prepare(data: SceneData, warnings: string[] = []): Promise<void> {
    const ids = this.project.usedAssetIds([]);
    for (const id of sceneAssetIds(data)) ids.add(id);
    const pending = [...this.project.withDependencies(ids)].filter((id) => !this.has(id) && !this.project.prefabData(id));
    await Promise.all(pending.map((id) => this.load(id, warnings)));
  }

  /** Whether the asset was loaded (or tried and failed). */
  has(assetId: string): boolean {
    return this.assets.has(assetId) || this.clips.has(assetId);
  }

  /**
   * (Re)loads one asset from its files in the project. Objects that use the old meshes, textures or clips keep
   * them; look the new ones up by ref. Returns false (with a warning) when it can't be loaded.
   */
  async load(assetId: string, warnings: string[] = []): Promise<boolean> {
    this.forget(assetId);
    const asset = this.project.getAsset(assetId);
    if (!asset) {
      this.assets.set(assetId, null);
      warnings.push(`Asset ${assetId} is missing from the project`);
      return false;
    }
    const [main, ...companions] = asset.files;
    try {
      if (isAudioFile(main.name)) {
        const clip = await loadAudioClip(main.name, main.bytes.slice().buffer);
        clip.ref = { asset: assetId, index: 0 };
        this.clips.set(assetId, clip);
      } else if (isImageFile(main.name)) {
        const texture = await loadImageTexture(main.name, main.bytes.slice().buffer);
        texture.ref = { asset: assetId, index: 0 };
        this.assets.set(assetId, { meshes: [], textures: [texture], model: null });
      } else {
        const model = await loadModelFromBytes(main.name, main.bytes.slice().buffer, bytesResolver(companions));
        this.assets.set(assetId, { ...tagAssetResources(model, assetId), model });
      }
      return true;
    } catch (err) {
      if (isAudioFile(main.name)) this.clips.set(assetId, null);
      else this.assets.set(assetId, null);
      warnings.push(`Could not load ${asset.name}: ${(err as Error).message}`);
      return false;
    }
  }

  /** Drops what was loaded for an asset, so the next prepare() or load() reads its files again. */
  forget(assetId: string): void {
    this.assets.delete(assetId);
    this.clips.delete(assetId);
  }

  /** The loaded hierarchy of a model asset, to clone into a scene (clones share its meshes and textures). */
  model(assetId: string): GameObject | null {
    return this.assets.get(assetId)?.model ?? null;
  }

  /** A new Scene holding `entry`'s objects, with `scripts` as its library (load the project's scripts into it first). */
  async instantiate(entry: ProjectScene, scripts: ScriptLibrary, warnings: string[] = []): Promise<Scene> {
    await this.prepare(entry.data, warnings);
    const scene = new Scene(scripts);
    scene.prefabs = this;
    applySceneData(scene, entry.data, this, warnings);
    return scene;
  }

  prefab(id: string): PrefabData | null {
    return this.project.prefabData(id);
  }

  /** A new instance of a prefab by name, path or id (prepare() loaded what it uses). Load problems are logged. */
  instantiatePrefab(key: string, scene: Scene): GameObject | null {
    const asset = this.project.findPrefab(key);
    if (!asset) return null;
    const warnings: string[] = [];
    const obj = instantiatePrefab(asset.id, scene, this, warnings);
    for (const w of warnings) console.warn(`${asset.name}: ${w}`);
    return obj;
  }

  /** Makes meshes and textures of an asset imported in this session resolvable without reloading it. */
  register(assetId: string, resources: { meshes: Mesh[]; textures: Texture[] }, model: GameObject | null = null): void {
    this.assets.set(assetId, { ...resources, model });
  }

  /** Makes a sound imported in this session resolvable without decoding it again. */
  registerClip(assetId: string, clip: AudioClip): void {
    this.clips.set(assetId, clip);
  }

  clip(ref: ClipRef): AudioClip | null {
    return 'sfx' in ref ? AudioClip.synth(ref.sfx) : (this.clips.get(ref.asset) ?? null);
  }

  mesh(ref: ResourceRef): Mesh | null {
    if ('primitive' in ref) {
      const key = `${ref.primitive}:${ref.args.join(',')}`;
      let m = this.primitives.get(key);
      if (!m) {
        m = buildPrimitive(ref.primitive, ref.args) ?? undefined;
        if (m) this.primitives.set(key, m);
      }
      return m ?? null;
    }
    return this.assets.get(ref.asset)?.meshes[ref.index] ?? null;
  }

  texture(ref: ResourceRef): Texture | null {
    return 'asset' in ref ? (this.assets.get(ref.asset)?.textures[ref.index] ?? null) : null;
  }
}
