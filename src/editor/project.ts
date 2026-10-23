import {
  CameraComponent,
  GameObject,
  Light,
  PROJECT_EXTENSION,
  Project,
  ProjectResources,
  Scene,
  applySceneData,
  quat,
  serializeScene,
  tagAssetResources,
  type Asset,
  type ProjectManifest,
  type SceneData,
} from '../engine';
import type { Editor } from './editor';

// Project persistence for the editor: the open project, its scenes, Save/Open
// of .messier files, and an IndexedDB autosave of the working copy.
//
// Change detection is by value: every CHECK_INTERVAL_MS the current scene is
// serialized and the manifest JSON compared with the last saved and autosaved
// versions. Inspector edits aren't all undoable commands, so watching the undo
// history would miss changes. Scenes are small, so this costs well under a
// millisecond.

const CHECK_INTERVAL_MS = 1000;
const DB_NAME = 'messier';
const AUTOSAVE_KEY = 'autosave';
/** Where script sources lived before projects; read once by Editor.restoreLegacyScripts(). */
export const LEGACY_SCRIPTS_KEY = 'messier.scripts.v1';

interface AutosaveRecord {
  json: string;
  /** Unsaved to a file at the time of the autosave. */
  dirty: boolean;
  handle?: FileSystemFileHandle | null;
}

// File System Access API pieces missing from lib.dom (Chromium only).
interface FilePickerOptions {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}
type PickerWindow = Window & {
  showSaveFilePicker?: (opts: FilePickerOptions) => Promise<FileSystemFileHandle>;
  showOpenFilePicker?: (opts: FilePickerOptions) => Promise<FileSystemFileHandle[]>;
};
type PermissionHandle = FileSystemFileHandle & {
  queryPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>;
};
const FILE_TYPES = [{ description: 'Messier project', accept: { 'application/octet-stream': [PROJECT_EXTENSION] } }];

export class ProjectManager {
  project = new Project();
  /** Id of the scene shown in the editor. */
  sceneId = '';
  /** Changed since the last Save / Open. */
  dirty = false;
  /** Called when the project, the current scene or `dirty` changes. */
  onChange: (() => void) | null = null;

  private resources = new ProjectResources(this.project);
  private handle: FileSystemFileHandle | null = null;
  private savedJSON = '';
  private autosavedJSON = '';
  private storedAssets = new Set<string>();
  private autosaving = false;
  private autosaveOk = true;
  /** Set while a project or scene loads, so the periodic check doesn't save a half-built scene. */
  private busy = false;
  /** False until a project is in place: an early check would autosave an empty project over the stored one. */
  private ready = false;

  constructor(private readonly editor: Editor) {
    setInterval(() => this.check(), CHECK_INTERVAL_MS);
    window.addEventListener('beforeunload', (e) => {
      this.sync();
      // The autosave normally has everything; only warn when it is failing.
      if (this.dirty && !this.autosaveOk) e.preventDefault();
    });
  }

  get currentScene() {
    return this.project.getScene(this.sceneId);
  }

  /** File name for Save. */
  get fileName(): string {
    return this.handle?.name ?? `${this.project.name.replace(/[\\/:*?"<>|]+/g, '_') || 'Untitled'}${PROJECT_EXTENSION}`;
  }

  // ---------------------------------------------------------------------------
  // Boot

  /** Makes the scene currently in the editor (the demo) the first scene of a new, unsaved project. */
  adoptCurrentScene(projectName: string, sceneName = 'Main'): void {
    this.project.name = projectName;
    this.project.scenes = [{ id: newId(), name: sceneName, data: serializeScene(this.editor.scene) }];
    this.project.startScene = this.sceneId = this.project.scenes[0].id;
    this.ready = true;
    this.sync();
    this.savedJSON = this.json();
    this.setDirty(false);
    this.onChange?.();
  }

  /** Restores the autosaved working copy. Returns false when there is none (or it can't be read). */
  async restoreAutosave(): Promise<boolean> {
    let rec: AutosaveRecord | undefined;
    let project: Project;
    try {
      const db = await openDB();
      rec = await request<AutosaveRecord | undefined>(db.transaction('kv').objectStore('kv').get(AUTOSAVE_KEY));
      if (!rec) return false;
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
    await this.load(project, rec.handle ?? null);
    this.autosavedJSON = rec.json;
    if (rec.dirty) {
      this.savedJSON = '';
      this.setDirty(true);
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Assets

  /** Adds an imported model's files to the project, so scenes using it can be saved. */
  addAsset(asset: Asset, model: GameObject): void {
    this.project.assets.push(asset);
    this.resources.register(asset.id, tagAssetResources(model, asset.id));
  }

  // ---------------------------------------------------------------------------
  // Scenes

  async newScene(): Promise<void> {
    if (!this.canSwitch()) return;
    const name = uniqueName('Scene', this.project.scenes.map((s) => s.name));
    const scene = { id: newId(), name, data: defaultSceneData() };
    this.sync();
    this.project.scenes.push(scene);
    await this.showScene(scene.id);
  }

  async switchScene(id: string): Promise<void> {
    if (id === this.sceneId || !this.project.getScene(id) || !this.canSwitch()) return;
    this.sync();
    await this.showScene(id);
  }

  renameScene(id: string, name: string): void {
    const s = this.project.getScene(id);
    if (!s || !name.trim()) return;
    s.name = name.trim();
    this.changed();
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
    if (this.project.startScene === id) this.project.startScene = this.project.scenes[0].id;
    if (id === this.sceneId) await this.showScene(this.project.scenes[0].id);
    this.changed();
  }

  renameProject(name: string): void {
    if (!name.trim()) return;
    this.project.name = name.trim();
    this.changed();
  }

  // ---------------------------------------------------------------------------
  // Files

  async newProject(): Promise<void> {
    if (!this.confirmDiscard()) return;
    const p = new Project();
    p.scenes = [{ id: newId(), name: 'Main', data: defaultSceneData() }];
    p.startScene = p.scenes[0].id;
    await this.load(p, null);
  }

  /** Writes the project to its file (asking for one the first time). Play is stopped first: Save saves the edit-time scene. */
  async save(saveAs = false): Promise<boolean> {
    if (this.busy) return false;
    if (this.editor.engine.playing) this.editor.stopPlay();
    const warnings: string[] = [];
    this.sync(warnings);
    const bytes = this.project.encode();
    try {
      const picker = (window as PickerWindow).showSaveFilePicker;
      if (this.handle && !saveAs) await writeFile(this.handle, bytes);
      else if (picker) {
        const handle = await picker({ suggestedName: this.fileName, types: FILE_TYPES });
        await writeFile(handle, bytes);
        this.handle = handle;
      } else {
        download(bytes, this.fileName);
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') this.editor.notify(`Save failed: ${(err as Error).message}`, 'error');
      return false;
    }
    this.savedJSON = this.json();
    this.setDirty(false);
    this.autosavedJSON = ''; // store the clean state (and the file handle) too
    this.check();
    this.editor.notify(`Saved ${this.fileName}`, 'success');
    this.report(warnings, 'Saved without');
    return true;
  }

  /** Opens a .messier file, with the system picker where available (so Save writes back to it). */
  async open(): Promise<void> {
    const picker = (window as PickerWindow).showOpenFilePicker;
    if (!picker) {
      this.editor.pickFiles(); // importFiles() routes .messier files to openFile()
      return;
    }
    if (!this.confirmDiscard()) return;
    try {
      const [handle] = await picker({ types: FILE_TYPES });
      await this.openFile(await handle.getFile(), handle, false);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') this.editor.notify(`Open failed: ${(err as Error).message}`, 'error');
    }
  }

  async openFile(file: File, handle: FileSystemFileHandle | null = null, confirmFirst = true): Promise<void> {
    if (confirmFirst && !this.confirmDiscard()) return;
    let project: Project;
    try {
      project = Project.decode(await file.arrayBuffer());
    } catch (err) {
      this.editor.notify(`Could not open ${file.name}: ${(err as Error).message}`, 'error');
      return;
    }
    await this.load(project, handle);
    this.editor.notify(`Opened ${file.name}`, 'success');
  }

  // ---------------------------------------------------------------------------

  private async load(project: Project, handle: FileSystemFileHandle | null): Promise<void> {
    if (this.editor.engine.playing) this.editor.stopPlay();
    this.project = project;
    this.resources = new ProjectResources(project);
    this.handle = handle;
    this.storedAssets.clear();
    this.ready = true;
    this.editor.loadScripts(project.scripts);
    await this.showScene(project.startScene);
    this.savedJSON = this.json();
    this.setDirty(false);
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

  /** Copies the live scene and scripts into the project. Skipped while playing: Play mutates the scene and Stop restores it. */
  private sync(warnings?: string[]): void {
    if (!this.ready || this.busy || this.editor.engine.playing) return;
    const entry = this.currentScene;
    if (entry) entry.data = serializeScene(this.editor.scene, warnings);
    this.project.scripts = this.editor.scene.scripts.scripts.map((s) => ({ name: s.name, source: s.source }));
  }

  private json(): string {
    return JSON.stringify(this.project.manifest());
  }

  /** Periodic change detection and autosave. */
  private check(): void {
    if (!this.ready || this.busy || this.editor.engine.playing) return;
    this.sync();
    const json = this.json();
    this.setDirty(json !== this.savedJSON);
    if (json !== this.autosavedJSON) void this.autosave(json);
  }

  private changed(): void {
    this.check();
    this.onChange?.();
  }

  private setDirty(dirty: boolean): void {
    if (dirty === this.dirty) return;
    this.dirty = dirty;
    this.onChange?.();
  }

  private async autosave(json: string): Promise<void> {
    if (this.autosaving) return;
    this.autosaving = true;
    try {
      const db = await openDB();
      const fresh = this.project.referencedAssets().filter((a) => !this.storedAssets.has(a.id));
      const tx = db.transaction(['kv', 'assets'], 'readwrite');
      for (const a of fresh) tx.objectStore('assets').put(a, a.id);
      const rec: AutosaveRecord = { json, dirty: this.dirty, handle: this.handle };
      try {
        tx.objectStore('kv').put(rec, AUTOSAVE_KEY);
      } catch {
        // Some browsers can't store file handles; keep the rest.
        tx.objectStore('kv').put({ ...rec, handle: null }, AUTOSAVE_KEY);
      }
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

  private canSwitch(): boolean {
    if (!this.editor.engine.playing) return true;
    this.editor.notify('Stop Play to change scenes');
    return false;
  }

  private confirmDiscard(): boolean {
    this.check();
    return !this.dirty || confirm(`Discard unsaved changes to "${this.project.name}"?`);
  }

  private report(warnings: string[], verb: string): void {
    if (!warnings.length) return;
    const more = warnings.length > 1 ? ` (+${warnings.length - 1} more)` : '';
    this.editor.notify(`${verb} some parts: ${warnings[0]}${more}`, 'error');
  }
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

function uniqueName(base: string, taken: string[]): string {
  for (let i = 1; ; i++) if (!taken.includes(`${base} ${i}`)) return `${base} ${i}`;
}

async function writeFile(handle: FileSystemFileHandle, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  const h = handle as PermissionHandle;
  if (h.queryPermission && (await h.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    if ((await h.requestPermission?.({ mode: 'readwrite' })) !== 'granted') throw new Error('Permission to write the file was denied');
  }
  const w = await handle.createWritable();
  await w.write(bytes);
  await w.close();
}

function download(bytes: Uint8Array<ArrayBuffer>, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
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
