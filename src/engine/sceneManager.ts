import type { Engine } from './engine';
import { GameObject, type Scene } from './scene';
import { Signal } from './signal';

/** Where the scenes come from: a built game's embedded project, or the project open in the editor (during Play). */
export interface SceneSource {
  /** Scene names in build order. */
  readonly names: readonly string[];
  /** Builds a fresh, not yet running copy of scene `index`. */
  load(index: number): Promise<Scene>;
}

/**
 * Switches between the scenes of a game: `sceneManager.loadScene('Level 2')` or `loadScene(1)`, by the order of
 * File → Build. The host attaches a source (the game page, or the editor while playing); without one, loading
 * fails with a warning.
 *
 * Loading is asynchronous (imported models may have to be decoded first), so the new scene replaces the active one
 * after the current frame at the earliest. Until then the old scene keeps running. When several loads overlap, the
 * last one wins. Replacing a scene stops it (onDisable → onDestroy) and, if this manager loaded it, destroys its
 * objects.
 */
export class SceneManager {
  /** Emitted after loadScene() made a scene active, with its build index. */
  readonly sceneLoaded = new Signal<[scene: Scene, index: number]>();
  /** Where load problems go. Defaults to console.warn. */
  onWarning: ((message: string) => void) | null = null;

  private _engine: Engine | null = null;
  private _source: SceneSource | null = null;
  private _activeIndex = -1;
  private _request = 0;
  private _pending = 0;
  private _owned: Scene | null = null;

  /** Called by the host. `activeIndex` is the build index of the scene already active, if any. */
  attach(engine: Engine, source: SceneSource, activeIndex = -1): void {
    this.detach();
    this._engine = engine;
    this._source = source;
    this._activeIndex = activeIndex;
  }

  /** Called by the host when the game stops. Loads still in progress are dropped. */
  detach(): void {
    this._request++;
    this._engine = this._source = this._owned = null;
    this._activeIndex = -1;
  }

  /** Number of scenes in the build. */
  get sceneCount(): number {
    return this._source?.names.length ?? 0;
  }

  /** Name of the scene at a build index, or null. */
  sceneName(index: number): string | null {
    return this._source?.names[index] ?? null;
  }

  /** Build index of the active scene, or -1 (e.g. when Play started in a scene that isn't in the build). */
  get activeSceneIndex(): number {
    return this._activeIndex;
  }

  get activeSceneName(): string | null {
    return this.sceneName(this._activeIndex);
  }

  /** True while a loadScene() is in progress. */
  get isLoading(): boolean {
    return this._pending > 0;
  }

  /** Makes a scene of the build active, by name or build index. Resolves to it, or to null if it didn't load. */
  async loadScene(scene: string | number): Promise<Scene | null> {
    const engine = this._engine;
    const source = this._source;
    if (!engine || !source) {
      this.warn(`Can't load scene ${JSON.stringify(scene)}: no game is running`);
      return null;
    }
    const index = typeof scene === 'number' ? scene : source.names.indexOf(scene);
    if (!Number.isInteger(index) || index < 0 || index >= source.names.length) {
      this.warn(`Scene ${JSON.stringify(scene)} isn't in the build (${source.names.map((n) => JSON.stringify(n)).join(', ') || 'no scenes'})`);
      return null;
    }
    const request = ++this._request;
    this._pending++;
    let next: Scene;
    try {
      next = await source.load(index);
    } catch (err) {
      this.warn(`Could not load scene ${JSON.stringify(source.names[index])}: ${(err as Error).message}`);
      return null;
    } finally {
      this._pending--;
    }
    if (request !== this._request) {
      dispose(next);
      return null;
    }
    const prev = engine.scene;
    engine.setActiveScene(next);
    if (prev === this._owned) dispose(prev);
    this._owned = next;
    this._activeIndex = index;
    this.sceneLoaded.emit(next, index);
    return next;
  }

  private warn(message: string): void {
    if (this.onWarning) this.onWarning(message);
    else console.warn(message);
  }
}

/** Lets go of a scene that won't be shown again: scripts stop being hot-swap targets, signals disconnect. */
function dispose(scene: Scene): void {
  scene.setRunning(false);
  for (const o of [...scene.rootObjects]) GameObject.destroy(o);
}

/** Scene switching for scripts: `import { sceneManager } from 'messier'`. */
export const sceneManager = new SceneManager();
