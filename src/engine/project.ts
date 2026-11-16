import type { Mesh, ResourceRef } from './mesh';
import type { Texture } from './material';
import { Scene } from './scene';
import type { ScriptLibrary } from './scripting';
import { buildPrimitive } from './primitives';
import { bytesResolver, isAudioFile, isImageFile, loadAudioClip, loadImageTexture, loadModelFromBytes, type MemoryFile } from './loaders';
import { AudioClip, type ClipRef } from './audioClip';
import { applySceneData, checkSceneData, sceneAssetIds, tagAssetResources, type SceneData, type SceneResources } from './serialize';
import { isObject } from './data';

// A project is a set of scenes plus the scripts and imported assets they share.
// On disk it is one binary file laid out like a GLB:
//   header:  magic "MSPJ" | container version | total length   (3 x u32 LE)
//   chunk 0: length | "JSON" | manifest (UTF-8, space padded to 4 bytes)
//   chunk 1: length | "BIN\0" | asset file bytes, each 4-byte aligned (optional)
// The manifest holds every scene's SceneData, the script sources, the build
// settings, and for each asset file its { offset, length } in the BIN chunk.

export const PROJECT_FORMAT = 'messier-project';
export const PROJECT_VERSION = 1;
export const PROJECT_EXTENSION = '.messier';

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
    const ids = new Set<string>();
    for (const s of p.scenes) sceneAssetIds(s.data, ids);
    p.assets = this.assets.filter((a) => ids.has(a.id));
    return p;
  }

  /** Assets used by at least one scene, in project order. */
  referencedAssets(): Asset[] {
    const ids = new Set<string>();
    for (const s of this.scenes) sceneAssetIds(s.data, ids);
    return this.assets.filter((a) => ids.has(a.id));
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
      assets: this.referencedAssets().map((a) => ({ id: a.id, name: a.name, files: a.files.map((f) => ({ name: f.name, length: f.bytes.byteLength })) })),
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
      checkSceneData(s.data);
      p.scenes.push({ id: s.id, name: typeof s.name === 'string' ? s.name : 'Scene', data: s.data });
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
      if (files.length) p.assets.push({ id: entry.id, name: entry.name, files });
    }
    return p;
  }
}

const align4 = (n: number) => (n + 3) & ~3;

/**
 * Resolves scene refs for one project: rebuilds primitives and synthesized
 * sounds, and loads each imported asset once, sharing its meshes, textures and
 * clips across scene loads.
 */
export class ProjectResources implements SceneResources {
  private readonly assets = new Map<string, { meshes: Mesh[]; textures: Texture[] } | null>();
  private readonly clips = new Map<string, AudioClip | null>();
  private readonly primitives = new Map<string, Mesh>();

  constructor(readonly project: Project) {}

  /** Loads the assets `data` references that aren't loaded yet. Failures become warnings. */
  async prepare(data: SceneData, warnings: string[] = []): Promise<void> {
    const pending = [...sceneAssetIds(data)].filter((id) => !this.assets.has(id) && !this.clips.has(id));
    await Promise.all(
      pending.map(async (id) => {
        const asset = this.project.getAsset(id);
        if (!asset) {
          this.assets.set(id, null);
          warnings.push(`Asset ${id} is missing from the project`);
          return;
        }
        const [main, ...companions] = asset.files;
        if (isAudioFile(main.name)) {
          try {
            const clip = await loadAudioClip(main.name, main.bytes.slice().buffer);
            clip.ref = { asset: id, index: 0 };
            this.clips.set(id, clip);
          } catch (err) {
            this.clips.set(id, null);
            warnings.push(`Could not load ${asset.name}: ${(err as Error).message}`);
          }
          return;
        }
        if (isImageFile(main.name)) {
          try {
            const texture = await loadImageTexture(main.name, main.bytes.slice().buffer);
            texture.ref = { asset: id, index: 0 };
            this.assets.set(id, { meshes: [], textures: [texture] });
          } catch (err) {
            this.assets.set(id, null);
            warnings.push(`Could not load ${asset.name}: ${(err as Error).message}`);
          }
          return;
        }
        try {
          const model = await loadModelFromBytes(main.name, main.bytes.slice().buffer, bytesResolver(companions));
          this.assets.set(id, tagAssetResources(model, id));
        } catch (err) {
          this.assets.set(id, null);
          warnings.push(`Could not load ${asset.name}: ${(err as Error).message}`);
        }
      }),
    );
  }

  /** A new Scene holding `entry`'s objects, with `scripts` as its library (load the project's scripts into it first). */
  async instantiate(entry: ProjectScene, scripts: ScriptLibrary, warnings: string[] = []): Promise<Scene> {
    await this.prepare(entry.data, warnings);
    const scene = new Scene(scripts);
    applySceneData(scene, entry.data, this, warnings);
    return scene;
  }

  /** Makes meshes and textures of an asset imported in this session resolvable without reloading it. */
  register(assetId: string, resources: { meshes: Mesh[]; textures: Texture[] }): void {
    this.assets.set(assetId, resources);
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
