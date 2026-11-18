import {
  ASSETS_DIR,
  CameraComponent,
  GameObject,
  Light,
  MemoryFolder,
  Project,
  ProjectResources,
  SCENE_EXTENSION,
  TEXTURE_SLOTS,
  Scene,
  applySceneData,
  assetKind,
  dirName,
  fileName,
  fileStem,
  importAssetFile,
  isAssetPath,
  isAudioFile,
  isScenePath,
  isScriptPath,
  joinPath,
  loadAudioAsset,
  loadImageAsset,
  loadModelAssetsFromFiles,
  loadProjectFolder,
  manifestText,
  metaPath,
  metaText,
  newAssetId,
  prefabText,
  readPrefab,
  upgradeSceneData,
  quat,
  readScene,
  safeFileName,
  sceneText,
  scenePath,
  scriptPath,
  serializeScene,
  tagAssetResources,
  writeProjectFolder,
  writeTypeFiles,
  AudioSource,
  type Asset,
  type AudioClip,
  type ClipRef,
  type FolderIO,
  type PrefabData,
  type ResourceRef,
  type ProjectManifest,
  type ProjectScene,
  type SceneData,
  type Texture,
} from '../engine';
import type { Editor } from './editor';
import { download } from './build';
import { createZip } from './zip';
import { canPickFolders, filesFolder, folderPermission, handleFolder, pickFolder } from './folderIO';
import { FolderSync, type FolderChanges } from './folderSync';
import type { CapturedInstance } from './editor';
import { button, el } from './ui';

// Project persistence for the editor. A project is either a *folder* on disk (project.json, scenes/*.messier,
// scripts/*.ts, assets/**: see engine/projectFolder.ts), opened through the File System Access API, or kept *in the
// browser* (the demo on a first visit, browsers without folder access, old single-file projects) in an IndexedDB
// working copy.
//
// Change detection is by value: every CHECK_INTERVAL_MS the current scene and the scripts are serialized and
// compared with what was last written. Inspector edits aren't all undoable commands, so watching the undo history
// would miss changes. A folder project writes the scene, script and manifest files that differ; a browser project
// autosaves to IndexedDB. Changes made to the folder from outside (files dropped into assets/, a script edited in
// VS Code) come in through FolderSync.

const CHECK_INTERVAL_MS = 1000;
const DB_NAME = 'messier';
const AUTOSAVE_KEY = 'autosave';
/** Where script sources lived before projects; read once by Editor.restoreLegacyScripts(). */
export const LEGACY_SCRIPTS_KEY = 'messier.scripts.v1';
/** First bytes of a single-file project from before project folders ("MSPJ"). */
const LEGACY_MAGIC = [0x4d, 0x53, 0x50, 0x4a];
/** Served next to the editor by scripts/types-plugin.mjs. */
const TYPES_FILE = 'messier.d.ts';

interface AutosaveRecord {
  /** Browser project: its manifest JSON. */
  json?: string;
  /** Browser project: unsaved to a folder or file at the time of the autosave. */
  dirty?: boolean;
  /** Folder project: the folder, to reopen on the next visit. */
  folder?: FileSystemDirectoryHandle | null;
}

export class ProjectManager {
  project = new Project();
  /** Id of the scene shown in the editor (a folder project's scene ids are their paths). */
  sceneId = '';
  /** Changes not saved yet: to the folder (written within a second), or for a browser project, to any file. */
  dirty = false;
  /** Called when the project, the current scene or `dirty` changes. */
  onChange: (() => void) | null = null;
  /** Called when assets are added, removed, renamed or reloaded. */
  onAssetsChange: (() => void) | null = null;

  private resources = new ProjectResources(this.project);
  private folder: FolderIO | null = null;
  private folderHandle: FileSystemDirectoryHandle | null = null;
  private watcher: FolderSync | null = null;
  /** Folder project: path → text last written (or read) for project.json, scenes and scripts. */
  private readonly written = new Map<string, string>();
  /** Serializes folder work: writes, imports and outside changes never interleave. */
  private queue: Promise<unknown> = Promise.resolve();
  private savedJSON = '';
  private autosavedJSON = '';
  private storedAssets = new Set<string>();
  private autosaving = false;
  private autosaveOk = true;
  /** Set while a project or scene loads, so the periodic check doesn't save a half-built scene. */
  private busy = false;
  /** False until a project is in place: an early check would autosave an empty project over the stored one. */
  private ready = false;
  private folderInput: HTMLInputElement | null = null;
  /** messier.d.ts as served next to the editor ('' if it couldn't be fetched). */
  private types: Promise<string> | null = null;

  constructor(private readonly editor: Editor) {
    setInterval(() => this.check(), CHECK_INTERVAL_MS);
    window.addEventListener('beforeunload', (e) => {
      this.capture();
      // The autosave (or the folder) normally has everything; warn when it doesn't.
      if (this.folder ? this.pendingWrites().length > 0 : this.dirty && !this.autosaveOk) e.preventDefault();
    });
  }

  get currentScene() {
    return this.project.getScene(this.sceneId);
  }

  /** The open project folder's name, or null for a project kept in the browser. */
  get folderName(): string | null {
    return this.folderHandle?.name ?? null;
  }

  get isFolder(): boolean {
    return this.folder !== null;
  }

  /** File name for Download as .zip. */
  get fileName(): string {
    return `${safeFileName(this.project.name)}.zip`;
  }

  // ---------------------------------------------------------------------------
  // Boot

  /** Makes `project` (built in code: the demo) the open project, kept in the browser, not dirty. */
  async openProject(project: Project): Promise<void> {
    await this.load(project);
  }

  /**
   * Restores the last session: reopens its project folder (asking for permission if the browser wants a click
   * first), or the autosaved browser project. Returns false when there is nothing to restore (or the user declined).
   */
  async restoreAutosave(): Promise<boolean> {
    let rec: AutosaveRecord | undefined;
    try {
      const db = await openDB();
      rec = await request<AutosaveRecord | undefined>(db.transaction('kv').objectStore('kv').get(AUTOSAVE_KEY));
    } catch (err) {
      this.editor.notify(`Could not restore the last project: ${(err as Error).message}`, 'error');
      return false;
    }
    if (rec?.folder) {
      const handle = rec.folder;
      if (await folderPermission(handle, false)) return this.openFolder(handle, false);
      return this.reopenPrompt(handle);
    }
    if (!rec?.json) return false;
    let project: Project;
    try {
      const db = await openDB();
      const manifest = JSON.parse(rec.json) as ProjectManifest;
      const ids = (Array.isArray(manifest.assets) ? manifest.assets : []).map((a) => a.id);
      const store = db.transaction('assets').objectStore('assets');
      const assets = new Map<string, Asset | undefined>(await Promise.all(ids.map(async (id) => [id, await request<Asset | undefined>(store.get(id))] as const)));
      project = Project.fromManifest(manifest, (entry, file) => assets.get(entry.id)?.files.find((f) => f.name === file.name)?.bytes ?? null);
      // Drop stored assets that no longer belong to the project.
      const keys = await request<IDBValidKey[]>(db.transaction('assets').objectStore('assets').getAllKeys());
      const stale = keys.filter((k) => !assets.has(String(k)));
      if (stale.length) {
        const tx = db.transaction('assets', 'readwrite');
        for (const k of stale) tx.objectStore('assets').delete(k);
      }
      this.storedAssets = new Set(project.assets.map((a) => a.id));
    } catch (err) {
      this.editor.notify(`Could not restore the autosaved project: ${(err as Error).message}`, 'error');
      return false;
    }
    await this.load(project);
    this.autosavedJSON = rec.json;
    if (rec.dirty) {
      this.savedJSON = '';
      this.setDirty(true);
    }
    return true;
  }

  /** Browsers only let a page ask for a stored folder's permission after a click: a small prompt gets that click. */
  private reopenPrompt(handle: FileSystemDirectoryHandle): Promise<boolean> {
    return new Promise((resolve) => {
      const close = (reopen: boolean) => {
        box.remove();
        if (!reopen) resolve(false);
        else void this.openFolder(handle, false).then(resolve);
      };
      const box = el('div', { class: 'reopen-prompt', role: 'dialog' }, [
        el('div', { class: 'reopen-card' }, [
          el('h2', { text: `Reopen ${handle.name}?` }),
          el('p', { class: 'hint', text: 'Your browser asks before the editor can use the project folder again.' }),
          el('div', { class: 'reopen-actions' }, [
            button('Not now', () => close(false), 'btn'),
            button(`Reopen ${handle.name}`, () => close(true), 'btn btn-primary reopen-folder'),
          ]),
        ]),
      ]);
      document.body.append(box);
    });
  }

  // ---------------------------------------------------------------------------
  // Assets

  /** Every imported file in the project (assets/ of a folder project). */
  get assets(): readonly Asset[] {
    return this.project.assets;
  }

  /**
   * Imports files into the project and loads them: a folder project copies them into assets/ (a model with its
   * companion files into a directory of its own). Returns the assets that can be used on their own: models,
   * images and sounds, in the order given.
   */
  async importFiles(files: File[]): Promise<Asset[]> {
    if (!files.length) return [];
    if (this.folder) return this.enqueue(() => this.importIntoFolder(files));
    const out: Asset[] = [];
    const warnings: string[] = [];
    const models = files.filter((f) => assetKind(f.name) === 'model');
    if (models.length) {
      try {
        for (const { model, asset } of await loadModelAssetsFromFiles(files)) {
          this.project.assets.push(asset);
          this.resources.register(asset.id, tagAssetResources(model, asset.id), model);
          out.push(asset);
        }
      } catch (err) {
        warnings.push((err as Error).message);
      }
    }
    for (const f of files) {
      const kind = assetKind(f.name);
      if (kind === 'prefab') {
        const bytes = new Uint8Array(await f.arrayBuffer());
        try {
          readPrefab(bytes);
        } catch (err) {
          warnings.push(`Could not load ${f.name}: ${(err as Error).message}`);
          continue;
        }
        const asset: Asset = { id: newAssetId(), name: fileStem(f.name), files: [{ name: f.name, bytes }] };
        this.project.assets.push(asset);
        out.push(asset);
        continue;
      }
      if (kind !== 'image' && kind !== 'sound') continue;
      // With a model, images are its textures, not assets of their own.
      if (kind === 'image' && models.length) continue;
      try {
        if (kind === 'image') {
          const { texture, asset } = await loadImageAsset(f.name, await f.arrayBuffer());
          this.project.assets.push(asset);
          this.resources.register(asset.id, { meshes: [], textures: [texture] });
          out.push(asset);
        } else {
          const { clip, asset } = await loadAudioAsset(f.name, await f.arrayBuffer());
          this.project.assets.push(asset);
          this.resources.registerClip(asset.id, clip);
          out.push(asset);
        }
      } catch (err) {
        warnings.push(`Could not load ${f.name}: ${(err as Error).message}`);
      }
    }
    for (const w of warnings) this.editor.notify(w, 'error');
    this.onAssetsChange?.();
    return out;
  }

  private async importIntoFolder(files: File[]): Promise<Asset[]> {
    const io = this.folder!;
    const taken = new Set(this.project.assets.map((a) => a.path?.toLowerCase()));
    const unique = (path: string) => {
      let p = path;
      for (let i = 2; taken.has(p.toLowerCase()); i++) p = path.replace(/(\.[^./]*)?$/, (ext) => ` ${i}${ext}`);
      taken.add(p.toLowerCase());
      return p;
    };
    const models = files.filter((f) => assetKind(f.name) === 'model');
    // A model and its companions share a directory, so its relative references keep working.
    let dir = '';
    if (models.length) {
      dir = safeFileName(fileStem(models[0].name));
      for (let i = 2; this.project.assets.some((a) => a.path?.toLowerCase().startsWith(`${dir.toLowerCase()}/`)); i++) dir = `${safeFileName(fileStem(models[0].name))} ${i}`;
    }
    const written: string[] = [];
    for (const f of files) {
      const rel = dir ? `${dir}/${safeFileName(f.name)}` : unique(safeFileName(f.name));
      const path = joinPath(ASSETS_DIR, rel);
      await io.write(path, new Uint8Array(await f.arrayBuffer()));
      written.push(path);
    }
    const changes: FolderChanges = { added: written, changed: [], removed: [] };
    const imported = await this.applyChanges(changes);
    for (const p of written) await this.watcher?.noteWrite(p);
    // With a model, the other files are its companions; on their own, images and sounds are assets to use.
    return written.map((p) => imported.get(p)).filter((a): a is Asset => !!a && (dir ? kindOf(a) === 'model' : kindOf(a) !== 'other'));
  }

  /** Where the open scene's prefabs come from (the project's resources). */
  get prefabs(): ProjectResources {
    return this.resources;
  }

  /**
   * Adds a prefab asset holding `data`, named `name` (made unique): in a folder project the file assets/<name>.prefab.
   */
  async createPrefabAsset(name: string, data: PrefabData): Promise<Asset> {
    const taken = new Set(this.project.assets.map((a) => (a.path ?? a.files[0]?.name ?? '').toLowerCase()));
    let stem = safeFileName(name);
    for (let i = 2; taken.has(`${stem}.prefab`.toLowerCase()); i++) stem = `${safeFileName(name)} ${i}`;
    const file = `${stem}.prefab`;
    const asset: Asset = { id: newAssetId(), name: stem, files: [{ name: file, bytes: new TextEncoder().encode(prefabText(data)) }] };
    if (this.folder) {
      const io = this.folder;
      asset.path = file;
      await this.enqueue(async () => {
        for (const [path, contents] of [[joinPath(ASSETS_DIR, file), asset.files[0].bytes], [metaPath(joinPath(ASSETS_DIR, file)), metaText(asset.id)]] as const) {
          await io.write(path, contents);
          await this.watcher?.noteWrite(path);
        }
      });
    }
    this.project.assets.push(asset);
    this.prefabChanged(asset);
    return asset;
  }

  /** Replaces a prefab's contents (in a folder project, its file). Instances in the open scene are the caller's. */
  async writePrefab(asset: Asset, data: PrefabData): Promise<void> {
    const bytes = new TextEncoder().encode(prefabText(data));
    asset.files[0] = { name: asset.files[0].name, bytes };
    if (this.folder && asset.path) {
      const io = this.folder;
      const path = joinPath(ASSETS_DIR, asset.path);
      await this.enqueue(async () => {
        await io.write(path, bytes);
        await this.watcher?.noteWrite(path);
      });
    }
    this.prefabChanged(asset);
  }

  /** A browser project keeps assets in IndexedDB by id, and only writes new ones: a changed prefab must go again. */
  private prefabChanged(asset: Asset): void {
    if (!this.folder) {
      this.storedAssets.delete(asset.id);
      this.autosavedJSON = this.savedJSON = '';
    }
    this.onAssetsChange?.();
    this.markChanged();
  }

  /** A copy of a model asset's hierarchy (its own materials; meshes shared), or null if it isn't a loaded model. */
  instantiateModel(assetId: string): GameObject | null {
    const prefab = this.resources.model(assetId);
    if (!prefab) return null;
    const copy = prefab.clone();
    copy.traverse((o) => {
      if (o.material) o.material = o.material.clone();
    });
    return copy;
  }

  texture(assetId: string): Texture | null {
    return this.resources.texture({ asset: assetId, index: 0 });
  }

  /** The clip of an imported sound, once loaded. */
  audioClip(assetId: string): AudioClip | null {
    return this.resources.clip({ asset: assetId, index: 0 });
  }

  /** Imported sounds in the project, for the inspector's clip picker. */
  audioAssets(): Asset[] {
    return this.project.assets.filter((a) => isAudioFile(a.files[0]?.name ?? ''));
  }

  /** Renames an asset; in a folder project the file moves (with its .meta, so references hold). */
  async renameAsset(asset: Asset, name: string): Promise<void> {
    const clean = safeFileName(name.trim());
    if (!clean || clean === asset.name) return;
    if (!this.folder || !asset.path) {
      asset.name = clean;
      this.onAssetsChange?.();
      return;
    }
    const io = this.folder;
    await this.enqueue(async () => {
      const ext = fileName(asset.path!).match(/\.[^.]*$/)?.[0] ?? '';
      const to = joinPath(dirName(asset.path!), clean + ext);
      if (this.project.assets.some((a) => a !== asset && a.path?.toLowerCase() === to.toLowerCase())) {
        this.editor.notify(`There's already an asset called ${clean}${ext} there`, 'error');
        return;
      }
      for (const [from, dest] of [[asset.path!, to], [metaPath(asset.path!), metaPath(to)]]) {
        const src = joinPath(ASSETS_DIR, from), dst = joinPath(ASSETS_DIR, dest);
        await io.write(dst, await io.read(src));
        await io.remove(src);
        await this.watcher?.noteWrite(dst);
        await this.watcher?.noteWrite(src);
      }
      asset.path = to;
      asset.name = clean;
      asset.files[0].name = fileName(to);
    });
    this.onAssetsChange?.();
  }

  /** Removes an asset (and in a folder project its file). Objects already using it keep what they loaded. */
  async deleteAsset(asset: Asset): Promise<void> {
    const i = this.project.assets.indexOf(asset);
    if (i < 0) return;
    this.project.assets.splice(i, 1);
    if (this.folder && asset.path) {
      const io = this.folder;
      await this.enqueue(async () => {
        for (const p of [asset.path!, metaPath(asset.path!)]) {
          await io.remove(joinPath(ASSETS_DIR, p));
          await this.watcher?.noteWrite(joinPath(ASSETS_DIR, p));
        }
      });
    }
    this.onAssetsChange?.();
  }

  /** How many objects in the open scene use the asset (meshes, textures, sounds, the sky). */
  usesOf(assetId: string): number {
    let n = 0;
    this.editor.scene.traverse((o) => {
      const uses =
        (o.mesh?.ref && 'asset' in o.mesh.ref && o.mesh.ref.asset === assetId) ||
        TEXTURE_SLOTS.some((slot) => {
          const ref = o.material?.[slot]?.ref;
          return ref && 'asset' in ref && ref.asset === assetId;
        }) ||
        o.getComponents(AudioSource).some((s) => s.clip?.ref && 'asset' in s.clip.ref && s.clip.ref.asset === assetId) ||
        o.prefab === assetId;
      if (uses) n++;
    });
    const sky = this.editor.scene.sky.texture?.ref;
    if (sky && 'asset' in sky && sky.asset === assetId) n++;
    return n;
  }

  // ---------------------------------------------------------------------------
  // Scenes

  async newScene(): Promise<void> {
    if (!this.canSwitch()) return;
    const name = uniqueName('Scene', this.project.scenes.map((s) => s.name));
    const scene = { id: this.sceneIdFor(name), name, data: defaultSceneData() };
    this.capture();
    this.project.scenes.push(scene);
    await this.showScene(scene.id);
  }

  async switchScene(id: string): Promise<void> {
    if (id === this.sceneId || !this.project.getScene(id) || !this.canSwitch()) return;
    this.capture();
    await this.showScene(id);
  }

  renameScene(id: string, name: string): void {
    const s = this.project.getScene(id);
    const clean = name.trim();
    if (!s || !clean || clean === s.name) return;
    s.name = clean;
    if (this.folder) {
      // The scene's file is its id: the next check writes it under the new name and removes the old one.
      const to = this.sceneIdFor(clean, s);
      for (const e of this.project.build.scenes) if (e.id === id) e.id = to;
      if (this.project.startScene === id) this.project.startScene = to;
      if (this.sceneId === id) this.sceneId = to;
      s.id = to;
      s.name = fileStem(to);
    }
    this.markChanged();
  }

  async deleteScene(id: string): Promise<void> {
    const s = this.project.getScene(id);
    if (!s) return;
    if (this.project.scenes.length === 1) {
      this.editor.notify('A project needs at least one scene');
      return;
    }
    if (!this.canSwitch() || !confirm(`Delete scene "${s.name}"? This can't be undone.`)) return;
    this.project.scenes.splice(this.project.scenes.indexOf(s), 1);
    this.project.build.scenes = this.project.build.scenes.filter((e) => e.id !== id);
    if (this.project.startScene === id) this.project.startScene = this.project.scenes[0].id;
    if (id === this.sceneId) await this.showScene(this.project.scenes[0].id);
    this.markChanged();
  }

  renameProject(name: string): void {
    if (!name.trim()) return;
    this.project.name = name.trim();
    this.markChanged();
  }

  /** A fresh copy of a project scene, for loading scenes at runtime during Play (see sceneManager). */
  async instantiate(entry: ProjectScene): Promise<Scene> {
    const warnings: string[] = [];
    const scene = await this.resources.instantiate(entry, this.editor.scene.scripts, warnings);
    this.report(warnings, `Loaded ${entry.name} without`);
    return scene;
  }

  /** A folder project names scene files after their scenes; a browser project uses random ids. */
  private sceneIdFor(name: string, self?: ProjectScene): string {
    if (!this.folder) return newId();
    const taken = (p: string) => this.project.scenes.some((s) => s !== self && s.id.toLowerCase() === p.toLowerCase());
    let path = scenePath(name);
    for (let i = 2; taken(path); i++) path = scenePath(`${name} ${i}`);
    return path;
  }

  // ---------------------------------------------------------------------------
  // Files

  /** A new project: in a folder the user picks (where the browser can), else in the browser. */
  async newProject(): Promise<void> {
    if (!this.confirmDiscard()) return;
    const p = new Project();
    p.scenes = [{ id: newId(), name: 'Main', data: defaultSceneData() }];
    p.startScene = p.scenes[0].id;
    if (!canPickFolders()) {
      await this.load(p);
      return;
    }
    const handle = await this.pick();
    if (!handle) return;
    const io = handleFolder(handle);
    if (await io.stat('project.json')) {
      if (confirm(`${handle.name} already holds a Messier project. Open it?`)) await this.openFolder(handle, false);
      return;
    }
    if ((await io.list('')).some((e) => !e.name.startsWith('.')) && !confirm(`${handle.name} isn't empty. Create the project in it anyway?`)) return;
    p.name = handle.name;
    await writeProjectFolder(io, p);
    await this.openFolder(handle, false);
  }

  /** Writes changes now. A browser project is saved to a folder (where the browser can) or downloaded as a .zip. */
  async save(toNewFolder = false): Promise<boolean> {
    if (this.busy) return false;
    if (this.editor.engine.playing) this.editor.stopPlay();
    const warnings: string[] = [];
    this.capture(warnings);
    if (this.folder && !toNewFolder) {
      try {
        await this.enqueue(() => this.writeChanges());
      } catch (err) {
        this.editor.notify(`Save failed: ${(err as Error).message}`, 'error');
        return false;
      }
      this.editor.notify(`Saved ${this.folderName}`, 'success');
      this.report(warnings, 'Saved without');
      return true;
    }
    return canPickFolders() ? this.saveToFolder() : this.downloadZip();
  }

  /** Writes the project into a folder the user picks and continues there. */
  async saveToFolder(): Promise<boolean> {
    const handle = await this.pick();
    if (!handle) return false;
    const io = handleFolder(handle);
    if ((await io.stat('project.json')) && !confirm(`${handle.name} already holds a project. Replace it?`)) return false;
    this.capture();
    const sceneName = this.currentScene?.name;
    try {
      await writeProjectFolder(io, this.project);
    } catch (err) {
      this.editor.notify(`Save failed: ${(err as Error).message}`, 'error');
      return false;
    }
    if (!(await this.openFolder(handle, false))) return false;
    const same = this.project.scenes.find((s) => s.name === sceneName);
    if (same) await this.switchScene(same.id);
    this.editor.notify(`Saved to ${handle.name}`, 'success');
    return true;
  }

  /**
   * Writes a copy of the project into a folder the user picks (with the script types for code editors). The editor
   * stays with the project where it was.
   */
  async exportToFolder(): Promise<boolean> {
    const handle = await this.pick();
    if (!handle) return false;
    const io = handleFolder(handle);
    if ((await io.list('')).some((e) => !e.name.startsWith('.')) && !confirm(`${handle.name} isn't empty. Export into it anyway?`)) return false;
    this.capture();
    try {
      await writeProjectFolder(io, this.project);
      await writeTypeFiles(io, await this.typesText());
    } catch (err) {
      this.editor.notify(`Export failed: ${(err as Error).message}`, 'error');
      return false;
    }
    this.editor.notify(`Exported to ${handle.name}`, 'success');
    return true;
  }

  /** The project as a .zip of its folder layout, script types included. */
  async downloadZip(): Promise<boolean> {
    this.capture();
    const io = new MemoryFolder();
    await writeProjectFolder(io, this.project);
    await writeTypeFiles(io, await this.typesText());
    const root = safeFileName(this.project.name);
    const zip = await createZip([...io.files].map(([path, f]) => ({ name: `${root}/${path}`, data: f.bytes })));
    download(zip, this.fileName, 'application/zip');
    this.savedJSON = this.json();
    this.setDirty(false);
    this.editor.notify(`Downloaded ${this.fileName}`, 'success');
    return true;
  }

  /** Opens a project folder: with the folder picker where the browser has one, else read from a picked folder. */
  async open(): Promise<void> {
    if (!this.confirmDiscard()) return;
    if (canPickFolders()) {
      const handle = await this.pick();
      if (handle) await this.openFolder(handle, false);
      return;
    }
    if (!this.folderInput) {
      this.folderInput = el('input', { type: 'file', hidden: true, webkitdirectory: '' });
      this.folderInput.addEventListener('change', () => {
        const files = [...(this.folderInput!.files ?? [])];
        this.folderInput!.value = '';
        if (files.length) void this.openFolderFiles(files);
      });
      document.body.append(this.folderInput);
    }
    this.folderInput.click();
  }

  /** Opens a project folder for reading and writing. An empty folder becomes a new project. */
  async openFolder(handle: FileSystemDirectoryHandle, confirmFirst = true): Promise<boolean> {
    if (confirmFirst && !this.confirmDiscard()) return false;
    if (!(await folderPermission(handle, true))) {
      this.editor.notify(`No permission to use ${handle.name}`, 'error');
      return false;
    }
    const io = handleFolder(handle);
    let loaded: Awaited<ReturnType<typeof loadProjectFolder>>;
    try {
      loaded = await loadProjectFolder(io);
    } catch (err) {
      if ((await io.list('')).some((e) => !e.name.startsWith('.'))) {
        this.editor.notify(`Could not open ${handle.name}: ${(err as Error).message}`, 'error');
        return false;
      }
      const p = new Project();
      p.name = handle.name;
      p.scenes = [{ id: newId(), name: 'Main', data: defaultSceneData() }];
      p.startScene = p.scenes[0].id;
      await writeProjectFolder(io, p);
      loaded = await loadProjectFolder(io);
    }
    await this.load(loaded.project, loaded.resources, { io, handle });
    // Script types for VS Code: added, or updated when the folder has another version's.
    void this.enqueue(async () => {
      for (const p of await writeTypeFiles(io, await this.typesText())) await this.watcher?.noteWrite(p);
    }).catch(() => undefined);
    this.report(loaded.warnings, 'Opened without');
    this.editor.notify(`Opened ${handle.name}`, 'success');
    return true;
  }

  /** A folder picked where the browser can't write to it: the project is read into the browser. */
  private async openFolderFiles(files: File[]): Promise<void> {
    const name = files[0].webkitRelativePath.split('/')[0] || 'project';
    try {
      const io = await filesFolder(files);
      const { project, resources, warnings } = await loadProjectFolder(io);
      await this.load(project, resources);
      this.report(warnings, 'Opened without');
      this.editor.notify(`Opened ${name} in the browser. Changes stay here: use Download as .zip to keep them.`, 'success');
    } catch (err) {
      this.editor.notify(`Could not open ${name}: ${(err as Error).message}`, 'error');
    }
  }

  /**
   * Opens a dropped or picked .messier file: a scene file joins the project as a new scene; a single-file project
   * from before project folders opens in the browser.
   */
  async openFile(file: File): Promise<void> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (LEGACY_MAGIC.every((b, i) => bytes[i] === b)) {
      if (!this.confirmDiscard()) return;
      let project: Project;
      try {
        project = Project.decode(bytes);
      } catch (err) {
        this.editor.notify(`Could not open ${file.name}: ${(err as Error).message}`, 'error');
        return;
      }
      await this.load(project);
      this.editor.notify(`Opened ${file.name}, a single-file project. Save it (Ctrl+S) to turn it into a project folder.`, 'success');
      return;
    }
    let data: SceneData;
    try {
      data = upgradeSceneData(JSON.parse(new TextDecoder().decode(bytes)));
    } catch (err) {
      this.editor.notify(`Could not open ${file.name}: ${(err as Error).message}`, 'error');
      return;
    }
    if (!this.canSwitch()) return;
    const name = uniqueName(file.name.replace(new RegExp(`\\${SCENE_EXTENSION}$`, 'i'), '') || 'Scene', this.project.scenes.map((s) => s.name), true);
    const scene = { id: this.sceneIdFor(name), name, data };
    this.capture();
    this.project.scenes.push(scene);
    await this.showScene(scene.id);
    this.editor.notify(`Added scene ${name}`, 'success');
  }

  /** messier.d.ts from next to the editor (vite builds it); '' when it can't be had, so folders just go without. */
  private typesText(): Promise<string> {
    return (this.types ??= fetch(`${import.meta.env.BASE_URL}${TYPES_FILE}`)
      .then((r) => (r.ok ? r.text() : ''))
      .catch(() => ''));
  }

  private async pick(): Promise<FileSystemDirectoryHandle | null> {
    try {
      return await pickFolder();
    } catch (err) {
      if ((err as Error).name !== 'AbortError') this.editor.notify(`Could not open the folder: ${(err as Error).message}`, 'error');
      return null;
    }
  }

  // ---------------------------------------------------------------------------

  private async load(project: Project, resources?: ProjectResources, folder?: { io: FolderIO; handle: FileSystemDirectoryHandle }): Promise<void> {
    if (this.editor.engine.playing) this.editor.stopPlay();
    this.watcher?.stop();
    this.watcher = null;
    this.project = project;
    this.resources = resources ?? new ProjectResources(project);
    this.folder = folder?.io ?? null;
    this.folderHandle = folder?.handle ?? null;
    this.storedAssets.clear();
    this.written.clear();
    this.ready = true;
    this.editor.loadScripts(project.scripts);
    await this.showScene(project.startScene);
    this.savedJSON = this.json();
    this.setDirty(false);
    if (folder) {
      // As read from disk; the first check writes only what loading changed.
      for (const [path, text] of this.folderTexts()) this.written.set(path, text);
      for (const s of project.scenes) this.written.set(s.id, sceneText(s.data));
      this.watcher = new FolderSync(folder.io, (changes) => this.enqueue(() => this.applyChanges(changes)).then(() => undefined));
      await this.watcher.start(folder.handle);
      void this.remember({ folder: folder.handle });
    }
    this.onAssetsChange?.();
    this.onChange?.();
  }

  private async showScene(id: string): Promise<void> {
    const entry = this.project.getScene(id);
    if (!entry) return;
    const warnings: string[] = [];
    this.busy = true;
    try {
      await this.resources.prepare(entry.data, warnings);
      this.editor.beforeSceneLoad();
      this.sceneId = id;
      this.project.startScene = id;
      this.editor.scene.prefabs = this.resources;
      applySceneData(this.editor.scene, entry.data, this.resources, warnings);
    } catch (err) {
      warnings.push((err as Error).message);
    } finally {
      this.busy = false;
    }
    this.editor.afterSceneLoad();
    this.report(warnings, 'Loaded without');
    this.onChange?.();
  }

  /** Copies the live scene and scripts into the project now, instead of at the next periodic check. */
  flush(warnings?: string[]): void {
    this.capture(warnings);
  }

  /** Copies the live scene and scripts into the project. Skipped while playing: Play mutates the scene and Stop restores it. */
  private capture(warnings?: string[]): void {
    if (!this.ready || this.busy || this.editor.engine.playing) return;
    const entry = this.currentScene;
    if (entry) entry.data = serializeScene(this.editor.scene, warnings);
    this.project.scripts = this.editor.scene.scripts.scripts.map((s) => ({ name: s.name, source: s.source }));
  }

  private json(): string {
    return JSON.stringify(this.project.manifest());
  }

  /** Periodic change detection: writes to the folder, or autosaves a browser project. */
  private check(): void {
    if (!this.ready || this.busy || this.editor.engine.playing) return;
    this.capture();
    if (this.folder) {
      if (this.pendingWrites().length) {
        this.setDirty(true);
        void this.enqueue(() => this.writeChanges()).catch((err) => this.editor.notify(`Could not write to ${this.folderName}: ${(err as Error).message}`, 'error'));
      }
      return;
    }
    const json = this.json();
    this.setDirty(json !== this.savedJSON);
    if (json !== this.autosavedJSON) void this.autosave(json);
  }

  /** Call after changing the project directly (names, build settings): updates the dirty flag and the UI. */
  markChanged(): void {
    this.check();
    this.onChange?.();
  }

  private setDirty(dirty: boolean): void {
    if (dirty === this.dirty) return;
    this.dirty = dirty;
    this.onChange?.();
  }

  // ---- folder projects

  /** What the folder should hold for the manifest, scenes and scripts. */
  private folderTexts(): Map<string, string> {
    const texts = new Map<string, string>([['project.json', manifestText(this.project)]]);
    for (const s of this.project.scenes) texts.set(s.id, sceneText(s.data));
    for (const s of this.project.scripts) texts.set(scriptPath(s.name), s.source);
    return texts;
  }

  /** Paths whose files differ from the project (to write, or to remove). */
  private pendingWrites(): string[] {
    const texts = this.folderTexts();
    const out = [...texts].filter(([path, t]) => this.written.get(path) !== t).map(([path]) => path);
    for (const path of this.written.keys()) if (!texts.has(path)) out.push(path);
    return out;
  }

  private async writeChanges(): Promise<void> {
    const io = this.folder;
    if (!io) return;
    const texts = this.folderTexts();
    for (const [path, t] of texts) {
      if (this.written.get(path) === t) continue;
      await io.write(path, t);
      this.written.set(path, t);
      await this.watcher?.noteWrite(path);
    }
    for (const path of [...this.written.keys()]) {
      if (texts.has(path)) continue;
      await io.remove(path);
      this.written.delete(path);
      await this.watcher?.noteWrite(path);
    }
    this.savedJSON = this.json();
    this.setDirty(false);
  }

  /**
   * Brings in changes to the folder: files added to or changed in assets/ are (re)loaded, and objects using them
   * get the new meshes, textures and sounds; scripts, scenes and project.json edited outside replace the editor's.
   * Returns the assets loaded, by path.
   */
  private async applyChanges(c: FolderChanges): Promise<Map<string, Asset>> {
    const io = this.folder!;
    const warnings: string[] = [];
    const loaded = new Map<string, Asset>();
    const reloaded = new Set<string>();
    const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

    // assets/: new and changed files, then models whose companion files changed.
    const touched = [...c.added, ...c.changed].filter(isAssetPath);
    // Prefabs edited outside: instances in the scene are rebuilt from what they saved against the old version.
    const prefabPaths = [...touched, ...c.removed].filter((p) => isAssetPath(p) && assetKind(p) === 'prefab');
    const instances: CapturedInstance[] = prefabPaths.length && !this.editor.engine.playing ? this.editor.captureInstances() : [];
    for (const path of touched) {
      const asset = await importAssetFile(io, path, this.project, this.resources, warnings);
      await this.watcher?.noteWrite(metaPath(path));
      loaded.set(path, asset);
      reloaded.add(asset.id);
    }
    for (const path of c.changed.filter(isAssetPath)) {
      for (const a of this.project.assets) {
        if (reloaded.has(a.id) || assetKind(a.path ?? '') !== 'model') continue;
        const dir = joinPath(ASSETS_DIR, dirName(a.path!));
        if (dirName(path) === dir && a.files.some((f) => f.name === fileName(path))) {
          await importAssetFile(io, joinPath(ASSETS_DIR, a.path!), this.project, this.resources, warnings);
          reloaded.add(a.id);
        }
      }
    }
    for (const path of c.removed.filter(isAssetPath)) {
      const rel = path.slice(ASSETS_DIR.length + 1);
      const asset = this.project.assets.find((a) => a.path === rel);
      if (!asset) continue;
      this.project.assets.splice(this.project.assets.indexOf(asset), 1);
      if (this.usesOf(asset.id)) warnings.push(`${path} was removed, but the scene still uses it`);
    }
    if (reloaded.size) this.swapResources(reloaded);
    if (instances.length) {
      const ids = new Set(prefabPaths.map((p) => this.project.assets.find((a) => a.path === p.slice(ASSETS_DIR.length + 1))?.id ?? '').filter(Boolean));
      // A removed prefab's instances stay as they are (saving them turns them into plain objects).
      if (ids.size) this.editor.rebuildInstances(instances, ids, false, warnings);
    }

    // scripts/
    for (const path of [...c.added, ...c.changed].filter(isScriptPath)) {
      const source = decode(await io.read(path));
      this.written.set(path, source);
      this.editor.applyScriptSource(fileStem(path), source);
    }
    for (const path of c.removed.filter(isScriptPath)) {
      if (!this.written.has(path)) continue;
      this.written.delete(path);
      this.editor.removeScriptNamed(fileStem(path));
    }
    if (c.added.some(isScriptPath) || c.changed.some(isScriptPath) || c.removed.some(isScriptPath)) this.capture();

    // scenes/
    for (const path of [...c.added, ...c.changed].filter(isScenePath)) {
      const raw = decode(await io.read(path));
      if (this.written.get(path) === raw) continue;
      let scene: ProjectScene;
      try {
        scene = await readScene(io, path);
      } catch (err) {
        warnings.push(`${path}: ${(err as Error).message}`);
        continue;
      }
      this.written.set(path, sceneText(scene.data));
      const existing = this.project.getScene(path);
      if (!existing) this.project.scenes.push(scene);
      else {
        existing.data = scene.data;
        if (path === this.sceneId && !this.editor.engine.playing) await this.showScene(path);
      }
    }
    for (const path of c.removed.filter(isScenePath)) {
      const s = this.project.getScene(path);
      this.written.delete(path);
      if (!s || path === this.sceneId || this.project.scenes.length === 1) continue;
      this.project.scenes.splice(this.project.scenes.indexOf(s), 1);
      this.project.build.scenes = this.project.build.scenes.filter((e) => e.id !== path);
    }

    // project.json
    if (c.changed.includes('project.json')) {
      try {
        const raw = decode(await io.read('project.json'));
        const json: unknown = JSON.parse(raw);
        if (raw !== this.written.get('project.json') && typeof json === 'object' && json) {
          const m = json as { name?: unknown; build?: { title?: unknown; scenes?: unknown } };
          if (typeof m.name === 'string') this.project.name = m.name;
          if (m.build && typeof m.build.title === 'string') this.project.build.title = m.build.title;
          if (m.build && Array.isArray(m.build.scenes)) {
            this.project.build.scenes = m.build.scenes
              .filter((e): e is { id: string; enabled?: boolean } => typeof e?.id === 'string')
              .map((e) => ({ id: e.id, enabled: e.enabled !== false }));
          }
          this.written.set('project.json', manifestText(this.project));
        }
      } catch (err) {
        warnings.push(`project.json: ${(err as Error).message}`);
      }
    }

    this.report(warnings, 'Synced the folder without');
    const fresh = [...loaded.values()].filter((a) => c.added.includes(joinPath(ASSETS_DIR, a.path!)) && assetKind(a.path!) !== 'other');
    if (fresh.length) this.editor.notify(`New in assets: ${fresh.map((a) => fileName(a.path!)).join(', ')}`, 'success');
    if (loaded.size || c.removed.some(isAssetPath)) this.onAssetsChange?.();
    this.onChange?.();
    return loaded;
  }

  /** Points objects in the open scene at the newly loaded meshes, textures and sounds of `assetIds`. */
  private swapResources(assetIds: Set<string>): void {
    const scene = this.editor.scene;
    const res = this.resources;
    const ours = (ref: ResourceRef | ClipRef | null | undefined): ref is { asset: string; index: number } => !!ref && 'asset' in ref && assetIds.has(ref.asset);
    scene.traverse((o) => {
      if (o.mesh && ours(o.mesh.ref)) o.mesh = res.mesh(o.mesh.ref) ?? o.mesh;
      for (const slot of TEXTURE_SLOTS) {
        const tex = o.material?.[slot];
        if (o.material && tex && ours(tex.ref)) o.material[slot] = res.texture(tex.ref) ?? tex;
      }
      for (const s of o.getComponents(AudioSource)) if (s.clip && ours(s.clip.ref)) s.clip = res.clip(s.clip.ref) ?? s.clip;
    });
    const sky = scene.sky.texture;
    if (sky && ours(sky.ref)) scene.sky.texture = res.texture(sky.ref) ?? sky;
    this.editor.inspector.refresh();
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ---- browser projects

  private async autosave(json: string): Promise<void> {
    if (this.autosaving) return;
    this.autosaving = true;
    try {
      const db = await openDB();
      const fresh = this.project.referencedAssets().filter((a) => !this.storedAssets.has(a.id));
      const tx = db.transaction(['kv', 'assets'], 'readwrite');
      for (const a of fresh) tx.objectStore('assets').put(a, a.id);
      tx.objectStore('kv').put({ json, dirty: this.dirty } satisfies AutosaveRecord, AUTOSAVE_KEY);
      await done(tx);
      for (const a of fresh) this.storedAssets.add(a.id);
      this.autosavedJSON = json;
      this.autosaveOk = true;
      try {
        localStorage.removeItem(LEGACY_SCRIPTS_KEY); // the scripts are in the autosave now
      } catch {
        /* storage unavailable */
      }
    } catch (err) {
      if (this.autosaveOk) this.editor.notify(`Autosave failed: ${(err as Error).message}. Save the project to keep your work.`, 'error');
      this.autosaveOk = false;
    } finally {
      this.autosaving = false;
    }
  }

  /** Stores what the next visit should reopen. */
  private async remember(rec: AutosaveRecord): Promise<void> {
    try {
      const db = await openDB();
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(rec, AUTOSAVE_KEY);
      await done(tx);
    } catch {
      // Without it the next visit starts with the demo; the folder itself is fine.
    }
  }

  private canSwitch(): boolean {
    if (!this.editor.engine.playing) return true;
    this.editor.notify('Stop Play to change scenes');
    return false;
  }

  private confirmDiscard(): boolean {
    this.check();
    // A folder project's changes are on disk within a second.
    return this.folder !== null || !this.dirty || confirm(`Discard unsaved changes to "${this.project.name}"?`);
  }

  private report(warnings: string[], verb: string): void {
    if (!warnings.length) return;
    const more = warnings.length > 1 ? ` (+${warnings.length - 1} more)` : '';
    this.editor.notify(`${verb} some parts: ${warnings[0]}${more}`, 'error');
  }
}

/** Kind of an asset by its main file: what it can be used for. */
export function kindOf(a: Asset): ReturnType<typeof assetKind> {
  return assetKind(a.path ?? a.files[0]?.name ?? '');
}

/** A new scene: a sun and a camera, like the demo's but without content. */
function defaultSceneData(): SceneData {
  const s = new Scene();
  const sun = new GameObject('Sun');
  sun.light = new Light('directional', [1, 0.96, 0.9], 3);
  sun.light.castShadows = true;
  sun.transform.position = [0, 6, 0];
  sun.transform.setEulerDeg(-50, 30, 0);
  const cam = new GameObject('Main Camera');
  cam.camera = new CameraComponent();
  cam.transform.position = [0, 3, 8];
  cam.transform.rotation = quat.lookRotation([0, -0.35, -1]);
  s.add(sun);
  s.add(cam);
  return serializeScene(s);
}

let idCounter = 0;
function newId(): string {
  return `${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** `base N` not in `taken`; with `keepBase`, `base` itself when it's free. */
function uniqueName(base: string, taken: string[], keepBase = false): string {
  if (keepBase && !taken.includes(base)) return base;
  for (let i = keepBase ? 2 : 1; ; i++) if (!taken.includes(`${base} ${i}`)) return `${base} ${i}`;
}

// --- IndexedDB ----------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  return (dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('kv');
      req.result.createObjectStore('assets');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'));
  }).catch((err) => {
    dbPromise = null;
    throw err;
  }));
}

function request<T>(req: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}
