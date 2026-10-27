import {
  CameraComponent,
  DEG2RAD,
  GameObject,
  Light,
  Material,
  RigidBody,
  ScriptAsset,
  Script,
  IDENTITY_TRS,
  type LocalTRS,
  colliderCorners,
  fitCollider,
  getPrimitive,
  input,
  isFlatMesh,
  worldCollider,
  loadModelAssetsFromFiles,
  PROJECT_EXTENSION,
  raySphere,
  raycastScene,
  quat,
  vec3,
  worldBounds,
  boxCorners,
  type Behaviour,
  type Engine,
  type FrameInfo,
  type LightType,
  type OverlayBuilder,
  type PrimitiveKind,
  type Ray,
  type ScriptSource,
  type RenderStats,
  type Scene,
  type Vec3,
  type Vec4,
} from '../engine';
import { Gizmo, type GizmoMode, type Handle } from './gizmo';
import { History } from './history';
import { Selection } from './selection';
import { HierarchyPanel } from './hierarchy';
import { InspectorPanel } from './inspector';
import { OrbitControls } from './orbitControls';
import { LEGACY_SCRIPTS_KEY, ProjectManager } from './project';
import { ScriptsView } from './scriptsView';

type PointerMode = 'none' | 'click' | 'orbit' | 'pan' | 'gizmo' | 'fly';
export type EditorView = 'scene' | 'scripts';

/** Game keys whose browser default (scrolling, activating the focused button) would fight the game. */
const SCROLL_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']);


const SELECTION_COLOR: Vec4 = [0.13, 0.83, 0.93, 0.9]; // --accent
const COLLIDER_COLOR: Vec4 = [0.35, 1, 0.45, 0.85];
const CAMERA_COLOR: Vec4 = [0.8, 0.75, 1, 0.9];
const LIGHT_ICON_PX = 7;
/** Depth of the camera helper's frustum icon. */
const CAMERA_ICON_PX = 34;
const CLICK_SLOP_PX = 4;

export interface EditorElements {
  viewport: HTMLElement;
  canvas: HTMLCanvasElement;
  hierarchy: HTMLElement;
  inspector: HTMLElement;
  toolbar: HTMLElement;
  stats: HTMLElement;
  toasts: HTMLElement;
  dropOverlay: HTMLElement;
  importInput: HTMLInputElement;
  help: HTMLElement;
  scriptsView: HTMLElement;
}

/** Real-time scene editor: selection, gizmos, panels, undo/redo, play mode, import. */
export class Editor {
  readonly camera;
  readonly controls: OrbitControls;
  readonly gizmo: Gizmo;
  /** Undo history. Play gets a fresh one (its edits act on the play copy) and Stop brings the editing one back. */
  history = new History();
  readonly hierarchy: HierarchyPanel;
  readonly inspector: InspectorPanel;
  readonly scripts: ScriptsView;
  readonly project: ProjectManager;
  /** What's selected (hierarchy, inspector and viewport share it). */
  readonly selection = new Selection();
  showHelpers = true;
  view: EditorView = 'scene';
  /** Look through the scene's active camera instead of the editor camera (turned on by Play). */
  cameraView = false;

  private pointerMode: PointerMode = 'none';
  private pointerStart: [number, number] = [0, 0];
  private pointerLast: [number, number] = [0, 0];
  private readonly keys = new Set<string>();
  private transformBefore: LocalTRS | null = null;
  /** The scene being edited, while Play runs a clone of it. */
  private editScene: Scene | null = null;
  private editHistory: History | null = null;
  private cameraViewBeforePlay = false;
  private lastStats: RenderStats | null = null;
  private statsTimer = 0;

  constructor(
    readonly engine: Engine,
    private readonly ui: EditorElements,
  ) {
    this.camera = engine.camera;
    engine.useSceneCamera = false;
    this.controls = new OrbitControls(this.camera);
    this.gizmo = new Gizmo(this.camera);
    this.hierarchy = new HierarchyPanel(this, ui.hierarchy);
    this.inspector = new InspectorPanel(this, ui.inspector);
    this.scripts = new ScriptsView(this, ui.scriptsView);
    this.history.onChange = () => this.updateToolbar();
    this.selection.changed.connect(() => this.selectionChanged());
    this.project = new ProjectManager(this);
    // Toolbar only: rebuilding the inspector here would steal focus from a field being edited.
    this.project.onChange = () => this.updateToolbar();
    this.initScripts();

    this.bindViewport();
    this.bindKeyboard();
    this.bindToolbar();
    this.bindImport();

    engine.onBeforeRender((f) => this.frame(f));
    engine.onAfterRender((s) => (this.lastStats = s));
    this.inspector.show(null);
    this.updateToolbar();
  }

  // ---------------------------------------------------------------------------
  // Selection & scene operations

  /** The scene shown and edited: the engine's active scene (the play copy during Play). */
  get scene(): Scene {
    return this.engine.scene;
  }

  /** The active selected object: shown in the inspector and moved by the gizmo. */
  get selected(): GameObject | null {
    return this.selection.active;
  }

  /** Selects only `obj` (null clears the selection). */
  select(obj: GameObject | null): void {
    this.selection.set(obj);
  }

  private selectionChanged(): void {
    this.gizmo.hover = null;
    this.hierarchy.updateSelection();
    this.inspector.show(this.selected);
  }

  /** Adds an object to the scene as an undoable action and selects it. */
  addObject(obj: GameObject, parent: GameObject = this.scene.root, label = `Add ${obj.name}`): GameObject {
    parent.add(obj);
    const index = parent.children.indexOf(obj);
    this.history.push({
      label,
      undo: () => {
        parent.remove(obj);
        this.selection.retain((o) => o !== obj && !obj.isAncestorOf(o));
        this.hierarchy.markDirty();
      },
      redo: () => {
        parent.add(obj, Math.min(index, parent.children.length));
        this.hierarchy.markDirty();
      },
    });
    this.hierarchy.markDirty();
    this.select(obj);
    return obj;
  }

  deleteSelected(): void {
    const obj = this.selected;
    if (!obj || !obj.parent) return;
    const parent = obj.parent;
    const index = parent.children.indexOf(obj);
    parent.remove(obj);
    this.select(null);
    this.hierarchy.markDirty();
    this.history.push({
      label: `Delete ${obj.name}`,
      undo: () => {
        parent.add(obj, Math.min(index, parent.children.length));
        this.hierarchy.markDirty();
        this.select(obj);
      },
      redo: () => {
        parent.remove(obj);
        if (this.selected === obj) this.select(null);
        this.hierarchy.markDirty();
      },
    });
  }

  duplicateSelected(): void {
    const obj = this.selected;
    if (!obj || !obj.parent) return;
    const copy = obj.clone();
    copy.name = `${obj.name} copy`;
    copy.transform.position = vec3.add(copy.transform.position, [0.5, 0, 0.5]);
    this.addObject(copy, obj.parent, `Duplicate ${obj.name}`);
  }

  /** Moves `obj` under `parent`, keeping its world transform. Undoable. */
  reparent(obj: GameObject, parent: GameObject): void {
    if (obj === parent || obj.isAncestorOf(parent) || obj.parent === parent) return;
    const oldParent = obj.parent ?? this.scene.root;
    const oldIndex = oldParent.children.indexOf(obj);
    const oldTransform = obj.transform.snapshot();
    obj.setParentKeepWorld(parent);
    const newTransform = obj.transform.snapshot();
    this.history.push({
      label: `Parent ${obj.name}`,
      undo: () => {
        oldParent.add(obj, Math.min(oldIndex, oldParent.children.length));
        obj.transform.copyFrom(oldTransform);
        this.hierarchy.markDirty();
      },
      redo: () => {
        parent.add(obj);
        obj.transform.copyFrom(newTransform);
        this.hierarchy.markDirty();
      },
    });
    this.hierarchy.markDirty();
  }

  resetTransform(obj: GameObject): void {
    this.beginTransformEdit(obj);
    obj.transform.copyFrom(IDENTITY_TRS);
    this.commitTransformEdit(obj);
  }

  /** Snapshot taken at the start of a gizmo drag or inspector edit. */
  beginTransformEdit(obj: GameObject): void {
    this.transformBefore = obj.transform.snapshot();
  }

  commitTransformEdit(obj: GameObject): void {
    const before = this.transformBefore;
    this.transformBefore = null;
    if (!before) return;
    const after = obj.transform.snapshot();
    const same =
      vec3.equals(before.position, after.position) &&
      vec3.equals(before.scale, after.scale) &&
      before.rotation.every((v, i) => Math.abs(v - after.rotation[i]) < 1e-7);
    if (same) return;
    this.history.push({
      label: `Transform ${obj.name}`,
      undo: () => obj.transform.copyFrom(before),
      redo: () => obj.transform.copyFrom(after),
    });
  }

  /** Adds a rigid body fitted to the object's mesh. Flat meshes (planes) default to static. Undoable. */
  addRigidBody(obj: GameObject): void {
    if (obj.rigidBody) return;
    const rb = new RigidBody(isFlatMesh(obj.mesh) ? 'static' : 'dynamic');
    fitCollider(rb, obj.mesh);
    if (obj.mesh?.name === 'Sphere') rb.shape = 'sphere';
    this.setRigidBody(obj, rb, `Add rigid body to ${obj.name}`);
  }

  removeRigidBody(obj: GameObject): void {
    if (obj.rigidBody) this.setRigidBody(obj, null, `Remove rigid body from ${obj.name}`);
  }

  private setRigidBody(obj: GameObject, rb: RigidBody | null, label: string): void {
    const before = obj.rigidBody;
    const apply = (value: RigidBody | null) => {
      obj.rigidBody = value;
      if (this.selected === obj) this.inspector.refresh();
    };
    apply(rb);
    this.history.push({ label, undo: () => apply(before), redo: () => apply(rb) });
  }

  /** Attaches a behaviour (built-in or script). Undoable. */
  addBehaviour(obj: GameObject, b: Behaviour): void {
    // Attaching during Play wakes it like any component added at runtime.
    const apply = (on: boolean) => {
      if (on && !b.attached) obj.attachComponent(b);
      else if (!on && b.attached) obj.detachComponent(b);
      this.behavioursChanged(obj);
    };
    apply(true);
    this.history.push({ label: `Add ${b.typeName} to ${obj.name}`, undo: () => apply(false), redo: () => apply(true) });
  }

  removeBehaviour(obj: GameObject, b: Behaviour): void {
    const index = obj.components.indexOf(b);
    if (index < 0) return;
    const apply = (on: boolean) => {
      if (on && !b.attached) obj.attachComponent(b, index);
      else if (!on && b.attached) obj.detachComponent(b);
      this.behavioursChanged(obj);
    };
    apply(false);
    this.history.push({ label: `Remove ${b.typeName} from ${obj.name}`, undo: () => apply(true), redo: () => apply(false) });
  }

  private behavioursChanged(obj: GameObject): void {
    if (this.selected === obj) this.inspector.refresh();
    this.scripts.refresh();
  }

  // ---------------------------------------------------------------------------
  // Scripts

  setView(view: EditorView, script?: ScriptAsset): void {
    if (view === this.view && !script) return;
    if (this.view === 'scripts' && view !== 'scripts') this.scripts.compileNow();
    if (view !== this.view) this.endActiveGesture();
    this.view = view;
    document.body.classList.toggle('view-scripts', view === 'scripts');
    if (view === 'scripts') this.scripts.show(script);
    // Script fields may have changed while editing code.
    else this.inspector.refresh();
    this.updateToolbar();
  }

  /** Creates a script from the template (or `source`). Undoable. */
  createScript(name = 'NewScript', source?: string): ScriptAsset {
    const lib = this.scene.scripts;
    const asset = new ScriptAsset(lib.uniqueName(sanitizeScriptName(name)), '');
    asset.source = source ?? scriptTemplate(identifierFor(asset.name));
    const index = lib.scripts.length;
    lib.add(asset, index);
    this.compileScript(asset);
    this.history.push({
      label: `Create script ${asset.name}`,
      undo: () => {
        lib.remove(asset);
        this.scriptsChanged();
      },
      redo: () => {
        lib.add(asset, Math.min(index, lib.scripts.length));
        this.scriptsChanged();
      },
    });
    this.scriptsChanged();
    return asset;
  }

  /** Deletes a script and detaches it from every object using it. Undoable. */
  deleteScript(asset: ScriptAsset): void {
    const lib = this.scene.scripts;
    const index = lib.scripts.indexOf(asset);
    if (index < 0) return;
    const attached: [GameObject, number, Behaviour][] = [];
    this.scene.traverse((o) => {
      o.components.forEach((b, i) => {
        if (b instanceof Script && b.asset === asset) attached.push([o, i, b]);
      });
    });
    const apply = (remove: boolean) => {
      if (remove) {
        lib.remove(asset);
        for (const [o, , b] of attached) o.detachComponent(b);
      } else {
        lib.add(asset, Math.min(index, lib.scripts.length));
        for (const [o, i, b] of attached) if (!b.attached) o.attachComponent(b, i);
      }
      this.scriptsChanged();
      if (this.selected) this.inspector.refresh();
    };
    apply(true);
    this.history.push({ label: `Delete script ${asset.name}`, undo: () => apply(false), redo: () => apply(true) });
    this.notify(`Deleted ${asset.name}.ts${attached.length ? ` (removed from ${attached.length} object${attached.length > 1 ? 's' : ''})` : ''}. Undo with Ctrl+Z.`);
  }

  renameScript(asset: ScriptAsset, name: string): void {
    const clean = sanitizeScriptName(name);
    if (!clean || clean === asset.name) return;
    const before = asset.name;
    const after = this.scene.scripts.uniqueName(clean, asset);
    const apply = (n: string) => {
      asset.name = n;
      this.scriptsChanged();
      if (this.selected) this.inspector.refresh();
    };
    apply(after);
    this.history.push({ label: `Rename script ${before}`, undo: () => apply(before), redo: () => apply(after) });
  }

  /** Compiles a script (running objects pick up the new class). */
  compileScript(asset: ScriptAsset): boolean {
    const ok = asset.compile();
    this.updateToolbar();
    return ok;
  }

  private scriptsChanged(): void {
    this.scripts.refresh();
    this.updateToolbar();
  }

  private initScripts(): void {
    const lib = this.scene.scripts;
    lib.locateSyntaxError = locateSyntaxError;
    lib.onRuntimeError = (asset, diag, isNew) => {
      if (isNew) this.notify(`${asset.name}.ts${diag.line ? `:${diag.line}` : ''} — ${diag.message}${diag.object ? ` (on ${diag.object})` : ''}`, 'error');
      this.scripts.diagnosticsChanged(asset);
      if (this.selected) this.inspector.refresh();
      this.updateToolbar();
    };
  }

  /**
   * Compiles the scene's scripts after building a scene in code (the demo),
   * first applying sources saved by versions before projects existed. Those
   * are matched by name; the key is removed once the project autosaves.
   */
  restoreLegacyScripts(): void {
    const lib = this.scene.scripts;
    for (const { name, source } of loadStoredScripts()) {
      const existing = lib.get(name);
      if (existing) existing.source = source;
      else lib.add(new ScriptAsset(name, source));
    }
    for (const s of lib.scripts) if (s.compiledSource !== s.source) s.compile();
    this.scripts.refresh();
    this.updateToolbar();
  }

  /** Replaces every script with a project's (objects using the old ones are about to be replaced too). */
  loadScripts(sources: ScriptSource[]): void {
    const lib = this.scene.scripts;
    for (const s of [...lib.scripts]) lib.remove(s);
    for (const { name, source } of sources) lib.add(new ScriptAsset(name, source)).compile();
    this.scripts.refresh();
    this.updateToolbar();
  }

  /** Called by the project manager before it replaces the scene's objects. */
  beforeSceneLoad(): void {
    this.endActiveGesture();
    this.select(null);
    this.history.clear();
  }

  afterSceneLoad(): void {
    this.hierarchy.markDirty();
    this.inspector.show(null, true);
    this.scripts.refresh();
    this.updateToolbar();
  }

  /** Opens the file chooser used for Import (and Open without the File System Access API). */
  pickFiles(): void {
    this.ui.importInput.click();
  }

  focusSelected(): void {
    const obj = this.selected;
    if (!obj) {
      this.controls.focus([0, 0.5, 0], 4);
      return;
    }
    const b = worldBounds(obj);
    if (b) this.controls.focus(vec3.lerp(b.min, b.max, 0.5), Math.max(0.5, vec3.distance(b.min, b.max) / 2));
    else this.controls.focus(obj.worldPosition(), 1.5);
  }

  setMode(mode: GizmoMode): void {
    this.gizmo.mode = mode;
    this.updateToolbar();
  }

  createPrimitive(kind: PrimitiveKind): GameObject {
    const names: Record<PrimitiveKind, string> = { cube: 'Cube', sphere: 'Sphere', plane: 'Plane', cylinder: 'Cylinder', torus: 'Torus' };
    const obj = new GameObject(names[kind]);
    obj.mesh = getPrimitive(kind);
    obj.material = new Material(`${names[kind]} material`, { baseColor: [0.8, 0.8, 0.8, 1], roughness: 0.5 });
    obj.transform.position = this.spawnPoint(kind === 'plane' ? 0 : 0.5);
    return this.addObject(obj);
  }

  createLight(type: LightType): GameObject {
    const names: Record<LightType, string> = { directional: 'Directional Light', point: 'Point Light', spot: 'Spot Light' };
    const obj = new GameObject(names[type]);
    obj.light = new Light(type);
    if (type === 'spot') obj.light.range = 15;
    obj.transform.position = this.spawnPoint(type === 'directional' ? 4 : 2.5);
    if (type !== 'point') obj.transform.setEulerDeg(-60, 30, 0);
    if (type === 'directional') obj.light.castShadows = !this.scene.find((o) => !!o.light?.castShadows);
    return this.addObject(obj);
  }

  /** Adds a camera on the ground in front of the view, looking the way the editor camera does. */
  createCamera(): GameObject {
    const obj = new GameObject('Camera');
    obj.camera = new CameraComponent();
    obj.transform.position = this.spawnPoint(1.5);
    obj.transform.rotation = quat.lookRotation(this.camera.forward());
    return this.addObject(obj);
  }

  /** Moves an object to the editor camera's position and orientation. Undoable. */
  alignToView(obj: GameObject): void {
    this.beginTransformEdit(obj);
    obj.setWorldPosition(this.camera.position);
    obj.setWorldRotation(quat.lookRotation(this.camera.forward(), this.camera.up));
    this.commitTransformEdit(obj);
  }

  /** Switches the viewport between the editor camera and the scene's active camera. */
  setCameraView(on: boolean): void {
    if (on && !this.scene.activeCamera()) {
      this.notify('The scene has no visible camera. Add one with ＋ Add → Camera.');
      on = false;
    }
    if (on === this.cameraView) return;
    // Navigation and gizmos are off while looking through a scene camera.
    this.endActiveGesture();
    this.gizmo.hover = null;
    this.cameraView = on;
    this.engine.useSceneCamera = on;
    this.updateToolbar();
  }

  createEmpty(): GameObject {
    const obj = new GameObject('Empty');
    obj.transform.position = this.spawnPoint(0);
    return this.addObject(obj);
  }

  /** Point on the ground plane in front of the camera. */
  private spawnPoint(height: number): Vec3 {
    const t = this.camera.target;
    return [Math.round(t[0] * 2) / 2, height, Math.round(t[2] * 2) / 2];
  }

  async importFiles(files: File[]): Promise<void> {
    const project = files.find((f) => f.name.toLowerCase().endsWith(PROJECT_EXTENSION));
    if (project) {
      await this.project.openFile(project);
      return;
    }
    const scripts = files.filter((f) => /\.ts$/i.test(f.name));
    files = files.filter((f) => !scripts.includes(f));
    let lastScript: ScriptAsset | null = null;
    for (const f of scripts) {
      lastScript = this.createScript(f.name.replace(/\.ts$/i, ''), await f.text());
      this.notify(`Imported script ${lastScript.name}.ts`, 'success');
    }
    if (lastScript) this.setView('scripts', lastScript);
    if (files.length === 0) return;
    this.notify(`Importing ${files.map((f) => f.name).join(', ')}…`);
    try {
      const loaded = await loadModelAssetsFromFiles(files);
      for (const { model, asset } of loaded) {
        this.project.addAsset(asset, model);
        this.normalizeImportedScale(model);
        model.transform.position = vec3.add(model.transform.position, this.spawnPoint(0));
        this.addObject(model, this.scene.root, `Import ${model.name}`);
        this.notify(`Imported ${model.name}`, 'success');
      }
      this.focusSelected();
    } catch (err) {
      console.error(err);
      this.notify(`Import failed: ${(err as Error).message}`, 'error');
    }
  }

  /** Scales models authored in very large / small units to a few meters. */
  private normalizeImportedScale(model: GameObject): void {
    const b = worldBounds(model);
    if (!b) return;
    const size = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    if (size > 0 && (size > 40 || size < 0.05)) {
      const s = 3 / size;
      model.transform.scale = vec3.scale(model.transform.scale, s);
      this.notify(`${model.name}: rescaled ×${s.toPrecision(3)} to fit the scene`);
    }
    // Rest the model on the ground.
    const nb = worldBounds(model);
    if (nb) model.transform.position = vec3.add(model.transform.position, [0, -nb.min[1], 0]);
  }

  // ---------------------------------------------------------------------------
  // Play mode

  togglePlay(): void {
    if (this.engine.playing) this.stopPlay();
    else this.startPlay();
  }

  startPlay(): void {
    if (this.engine.playing) return;
    this.endActiveGesture();
    for (const s of this.scene.scripts.scripts) s.clearRuntimeErrors();
    // Play runs a copy, so Stop restores everything (including objects created or destroyed by scripts) by
    // switching back. Edits during Play go to the copy and get their own undo history.
    const edit = this.scene;
    const selected = this.selectionPaths();
    this.editScene = edit;
    this.editHistory = this.history;
    this.history = new History();
    this.history.onChange = () => this.updateToolbar();
    this.engine.setActiveScene(edit.clone());
    this.engine.setPlaying(true);
    this.sceneSwitched(selected);
    // Play shows the game through its camera (when it has one) until Stop, unless toggled off meanwhile.
    this.cameraViewBeforePlay = this.cameraView;
    if (this.scene.activeCamera()) this.setCameraView(true);
    // Take focus off the Play button (Space would click it again) and off any panel, so keys reach the game.
    if (this.view === 'scene') this.ui.canvas.focus();
    document.body.classList.add('playing');
    this.updateToolbar();
  }

  stopPlay(): void {
    if (!this.engine.playing) return;
    this.endActiveGesture();
    const selected = this.selectionPaths();
    this.engine.setPlaying(false);
    if (this.editScene) this.engine.setActiveScene(this.editScene);
    if (this.editHistory) this.history = this.editHistory;
    this.editScene = this.editHistory = null;
    this.sceneSwitched(selected);
    this.setCameraView(this.cameraViewBeforePlay);
    document.body.classList.remove('playing');
    this.updateToolbar();
  }

  /** Hierarchy paths of the selection, to find the same objects in another copy of the scene. */
  private selectionPaths(): SelectionPaths {
    return { items: this.selection.items.map(pathOf).filter((p): p is number[] => p !== null), active: pathOf(this.selected) };
  }

  /** After Play/Stop swapped scenes: select the counterparts of what was selected and rebuild the panels. */
  private sceneSwitched(paths: SelectionPaths): void {
    this.hierarchy.markDirty();
    const find = (p: number[] | null) => (p ? objectAt(this.scene.root, p) : null);
    const items = paths.items.map(find).filter((o): o is GameObject => o !== null);
    this.selection.setMany(items, find(paths.active));
    this.inspector.show(this.selected, true);
    this.scripts.refresh();
    this.updateToolbar();
  }

  // ---------------------------------------------------------------------------
  // Per-frame

  private frame(f: FrameInfo): void {
    this.controls.update(f.dt);
    if (this.pointerMode === 'fly') {
      const k = this.keys;
      const move: Vec3 = [
        (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0),
        (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0),
        (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0),
      ];
      this.controls.fly(move, f.dt, k.has('ShiftLeft') || k.has('ShiftRight'));
    }
    // A selected object may have been removed by undo or by a parent deletion.
    this.selection.retain((o) => this.isInScene(o));

    this.hierarchy.update();
    this.inspector.sync();
    // Helpers and gizmos aren't part of the game's view.
    if (!this.engine.viewObject) this.buildOverlay();

    this.statsTimer += f.dt;
    if (this.statsTimer > 0.25 && this.lastStats) {
      this.statsTimer = 0;
      const s = this.lastStats;
      this.ui.stats.textContent = `${this.engine.fps.toFixed(0)} fps · ${s.drawCalls} draws · ${formatCount(s.triangles)} tris · ${s.lights} lights${
        s.shadowCasters ? ` · ${s.shadowCasters} shadow casters` : ''
      }${this.engine.viewObject ? ` · viewing ${this.engine.viewObject.name}` : ''}`;
    }
  }

  private isInScene(obj: GameObject): boolean {
    let o: GameObject | null = obj;
    while (o && o !== this.scene.root) o = o.parent;
    return o === this.scene.root;
  }

  /** Visible objects drawn with a helper icon: lights and cameras. */
  private visibleHelpers(): GameObject[] {
    const out: GameObject[] = [];
    this.scene.traverse((o) => {
      if (!o.visible) return false;
      if (o.light || o.camera) out.push(o);
    });
    return out;
  }

  /** Frustum icon of constant screen size; the selected camera also shows its actual view volume. */
  private drawCamera(o: GameObject, overlay: OverlayBuilder): void {
    const cam = o.camera!;
    const m = o.worldMatrix;
    const pos: Vec3 = [m[12], m[13], m[14]];
    const f = vec3.normalize(vec3.transformDir(m, [0, 0, -1]));
    const u = vec3.normalize(vec3.transformDir(m, [0, 1, 0]));
    const r = vec3.normalize(vec3.cross(f, u));
    const aspect = this.camera.aspect;
    const persp = cam.projection === 'perspective';
    const tan = Math.tan((Math.min(cam.fovDeg, 150) * DEG2RAD) / 2);
    const rect = (dist: number, halfH: number): Vec3[] => {
      const c = vec3.addScaled(pos, f, dist);
      const x = vec3.scale(r, halfH * aspect), y = vec3.scale(u, halfH);
      return [vec3.add(vec3.add(c, x), y), vec3.add(vec3.sub(c, x), y), vec3.sub(vec3.sub(c, x), y), vec3.sub(vec3.add(c, x), y)];
    };
    const frustum = (near: Vec3[], far: Vec3[], color: Vec4, width: number) => {
      overlay.polyline(far, color, width, true, true);
      overlay.polyline(near, color, width, true, true);
      for (let i = 0; i < 4; i++) overlay.line(near[i], far[i], color, width, true);
    };
    const selected = o === this.selected;
    const d = overlay.pixelSize(pos) * CAMERA_ICON_PX * (selected ? 1.3 : 1);
    const halfH = persp ? d * tan : d * 0.5;
    frustum(persp ? rect(0, 0) : rect(0, halfH), rect(d, halfH), CAMERA_COLOR, 1.5);
    // Triangle above the top edge shows which way is up.
    const top = vec3.addScaled(vec3.addScaled(pos, f, d), u, halfH);
    const s = halfH * 0.45;
    overlay.triangle(vec3.addScaled(top, r, s), vec3.addScaled(top, r, -s), vec3.addScaled(top, u, s), CAMERA_COLOR, true);
    if (selected) {
      const far = Math.min(cam.far, persp ? 8 : 20);
      const h = (dist: number) => (persp ? dist * tan : cam.orthoSize);
      frustum(rect(cam.near, h(cam.near)), rect(far, h(far)), [CAMERA_COLOR[0], CAMERA_COLOR[1], CAMERA_COLOR[2], 0.45], 1);
    }
  }

  private buildOverlay(): void {
    const overlay = this.engine.overlay;
    const vh = this.ui.canvas.clientHeight;
    if (this.showHelpers) {
      for (const o of this.visibleHelpers()) {
        if (o.camera) this.drawCamera(o, overlay);
        if (!o.light) continue;
        const pos: Vec3 = [o.worldMatrix[12], o.worldMatrix[13], o.worldMatrix[14]];
        const c = o.light.color;
        const m = Math.max(c[0], c[1], c[2], 1e-3);
        const color: Vec4 = [c[0] / m, c[1] / m, c[2] / m, 1];
        const selected = o === this.selected;
        const px = overlay.pixelSize(pos);
        overlay.diamond(pos, px * LIGHT_ICON_PX * (selected ? 1.3 : 1), color, true);
        if (o.light.type !== 'point') {
          const dir = vec3.normalize(vec3.transformDir(o.worldMatrix, [0, 0, -1]));
          overlay.line(pos, vec3.addScaled(pos, dir, px * 60), [color[0], color[1], color[2], 0.8], 1.5, true);
          if (selected && o.light.type === 'spot') {
            const d = Math.min(o.light.range, 4);
            const r = d * Math.tan((o.light.outerAngle * Math.PI) / 180);
            const end = vec3.addScaled(pos, dir, d);
            overlay.circle(end, dir, r, [color[0], color[1], color[2], 0.6], 1.2, false, 48);
            const ref: Vec3 = Math.abs(dir[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
            const u = vec3.normalize(vec3.cross(dir, ref)), v = vec3.cross(dir, u);
            for (const s of [u, vec3.scale(u, -1), v, vec3.scale(v, -1)]) overlay.line(pos, vec3.addScaled(end, s, r), [color[0], color[1], color[2], 0.5], 1, false);
          }
        } else if (selected) {
          const r = o.light.range;
          const faded: Vec4 = [color[0], color[1], color[2], 0.35];
          overlay.circle(pos, [1, 0, 0], r, faded, 1, false, 64);
          overlay.circle(pos, [0, 1, 0], r, faded, 1, false, 64);
          overlay.circle(pos, [0, 0, 1], r, faded, 1, false, 64);
        }
      }
    }
    for (const o of this.selection.items) {
      const b = worldBounds(o);
      if (b) overlay.wireBox(boxCorners(b.min, b.max), SELECTION_COLOR, o === this.selected ? 1.5 : 1, true);
    }
    const sel = this.selected;
    if (sel) {
      const col = worldCollider(sel);
      if (col?.shape === 'box') overlay.wireBox(colliderCorners(col), COLLIDER_COLOR, 1.5, true);
      else if (col) for (const axis of col.axes) overlay.circle(col.center, axis, col.radius, COLLIDER_COLOR, 1.5, true, 48);
      this.gizmo.draw(overlay, sel, vh);
    }
  }

  // ---------------------------------------------------------------------------
  // Input

  private localPointer(e: PointerEvent | WheelEvent | MouseEvent): [number, number] {
    const r = this.ui.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private rayAt(x: number, y: number): Ray {
    const c = this.ui.canvas;
    return this.camera.screenRay(x, y, c.clientWidth, c.clientHeight);
  }

  private pickGizmo(x: number, y: number): Handle | null {
    if (!this.selected) return null;
    const c = this.ui.canvas;
    return this.gizmo.pick(this.selected, x, y, c.clientWidth, c.clientHeight);
  }

  /** Object under the cursor: light and camera icons first, then meshes. */
  private pickObject(x: number, y: number): GameObject | null {
    const ray = this.rayAt(x, y);
    if (this.showHelpers) {
      let bestHelper: GameObject | null = null;
      let bestT = Infinity;
      for (const o of this.visibleHelpers()) {
        let pos: Vec3 = [o.worldMatrix[12], o.worldMatrix[13], o.worldMatrix[14]];
        const px = this.engine.overlay.pixelSize(pos);
        let r = px * LIGHT_ICON_PX * 1.6;
        if (o.camera && !o.light) {
          // Sphere around the middle of the frustum icon.
          pos = vec3.addScaled(pos, vec3.normalize(vec3.transformDir(o.worldMatrix, [0, 0, -1])), px * CAMERA_ICON_PX * 0.6);
          r = px * CAMERA_ICON_PX * 0.6;
        }
        const t = raySphere(ray.origin, ray.dir, pos, r);
        if (t !== null && t < bestT) {
          bestT = t;
          bestHelper = o;
        }
      }
      if (bestHelper) return bestHelper;
    }
    const hit = raycastScene(this.scene, ray);
    if (!hit) return null;
    // First click selects the top-level object; clicking again drills down to the hit mesh.
    let top = hit.object;
    while (top.parent && top.parent !== this.scene.root) top = top.parent;
    if (this.selected && (this.selected === top || this.selected.isAncestorOf(hit.object))) {
      if (this.selected === hit.object) return hit.object;
      let o = hit.object;
      while (o.parent && o.parent !== this.selected) o = o.parent;
      return o;
    }
    return top;
  }

  private endActiveGesture(): void {
    if (this.pointerMode === 'gizmo' && this.selected) {
      this.gizmo.end();
      this.commitTransformEdit(this.selected);
    }
    this.pointerMode = 'none';
  }

  private bindViewport(): void {
    const canvas = this.ui.canvas;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      canvas.focus();
      const [x, y] = this.localPointer(e);
      this.pointerStart = [x, y];
      this.pointerLast = [x, y];
      if (this.engine.viewObject) return; // looking through a scene camera: no navigation or picking
      if (e.button === 0 && !e.altKey) {
        const handle = this.pickGizmo(x, y);
        if (handle !== null && this.selected) {
          this.pointerMode = 'gizmo';
          this.beginTransformEdit(this.selected);
          this.gizmo.begin(handle, this.selected, this.rayAt(x, y), x, y, canvas.clientHeight);
          return;
        }
        this.pointerMode = e.shiftKey ? 'pan' : 'click';
      } else if (e.button === 0 && e.altKey) {
        this.pointerMode = 'orbit';
      } else if (e.button === 1) {
        e.preventDefault();
        this.pointerMode = 'pan';
      } else if (e.button === 2) {
        this.pointerMode = 'fly';
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      const [x, y] = this.localPointer(e);
      const dx = x - this.pointerLast[0], dy = y - this.pointerLast[1];
      this.pointerLast = [x, y];
      switch (this.pointerMode) {
        case 'none': {
          const h = this.engine.viewObject ? null : this.pickGizmo(x, y);
          this.gizmo.hover = h;
          canvas.style.cursor = h !== null ? 'grab' : '';
          break;
        }
        case 'gizmo':
          if (this.selected) this.gizmo.update(this.selected, this.rayAt(x, y), x, y);
          canvas.style.cursor = 'grabbing';
          break;
        case 'click':
          if (Math.hypot(x - this.pointerStart[0], y - this.pointerStart[1]) > CLICK_SLOP_PX) this.pointerMode = 'orbit';
          break;
        case 'orbit':
        case 'fly':
          this.controls.orbit(dx, dy);
          break;
        case 'pan':
          this.controls.pan(dx, dy, canvas.clientHeight);
          break;
      }
    });

    const up = (e: PointerEvent) => {
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      const [x, y] = this.localPointer(e);
      if (this.pointerMode === 'click') {
        const hit = this.pickObject(x, y);
        // Ctrl/Cmd+click adds or removes; a plain click selects only what's under the cursor (or nothing).
        if (hit && (e.ctrlKey || e.metaKey)) this.selection.toggle(hit);
        else if (!e.ctrlKey && !e.metaKey) this.select(hit);
      }
      this.endActiveGesture();
      canvas.style.cursor = '';
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);

    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (this.engine.viewObject) return;
        const scale = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
        this.controls.zoom(e.deltaY * scale);
      },
      { passive: false },
    );
  }

  private bindKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      // Works everywhere, including inside the code editor.
      if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyE') {
        e.preventDefault();
        this.setView(this.view === 'scene' ? 'scripts' : 'scene');
        return;
      }
      // Save / Open work everywhere too (in the code editor, Ctrl+S also compiles), and during Play.
      if (mod && !e.altKey && (e.code === 'KeyS' || (e.code === 'KeyO' && !e.shiftKey))) {
        e.preventDefault();
        if (e.code === 'KeyO') void this.project.open();
        else void this.project.save(e.shiftKey);
        return;
      }
      const target = e.target as HTMLElement;
      if (target.closest('input, select, textarea')) return;
      // Scene shortcuts (W/E/R, Delete…) would act on an invisible scene; undo and Play still work.
      if (this.view !== 'scene') {
        if (e.code === 'KeyP' && !mod) this.togglePlay();
        else if (mod && (e.code === 'KeyZ' || e.code === 'KeyY')) {
          e.preventDefault();
          if (e.code === 'KeyY' || e.shiftKey) this.history.redo();
          else this.history.undo();
          this.hierarchy.markDirty();
        }
        return;
      }
      this.keys.add(e.code);
      if (this.pointerMode === 'fly') return; // WASD flies the camera
      // While playing, plain keys belong to the game's scripts (`input`), not to the editor's single-key
      // shortcuts, so a WASD player doesn't also switch gizmo modes. Esc stops Play; Ctrl shortcuts still work.
      if (this.engine.playing) {
        if (e.code === 'Escape' && !mod) {
          e.preventDefault();
          this.stopPlay();
          return;
        }
        input.keyDown(e.code);
        if (SCROLL_KEYS.has(e.code)) e.preventDefault();
        if (!mod) return;
      }
      if (mod && e.code === 'KeyZ') {
        e.preventDefault();
        if (e.shiftKey) this.history.redo();
        else this.history.undo();
        this.hierarchy.markDirty();
        return;
      }
      if (mod && e.code === 'KeyY') {
        e.preventDefault();
        this.history.redo();
        this.hierarchy.markDirty();
        return;
      }
      if (mod && e.code === 'KeyD') {
        e.preventDefault();
        this.duplicateSelected();
        return;
      }
      if (mod) return;
      switch (e.code) {
        case 'KeyW': this.setMode('translate'); break;
        case 'KeyE': this.setMode('rotate'); break;
        case 'KeyR': this.setMode('scale'); break;
        case 'KeyF': this.focusSelected(); break;
        case 'KeyG': this.engine.showGrid = !this.engine.showGrid; this.updateToolbar(); break;
        case 'KeyH': this.showHelpers = !this.showHelpers; this.updateToolbar(); break;
        case 'KeyC': this.setCameraView(!this.cameraView); break;
        case 'KeyX': this.gizmo.snap = !this.gizmo.snap; this.updateToolbar(); break;
        case 'KeyP': this.togglePlay(); break;
        case 'Delete':
        case 'Backspace': this.deleteSelected(); break;
        case 'Escape':
          if (!this.ui.help.hidden) this.ui.help.hidden = true;
          else this.select(null);
          break;
        case 'Slash':
          if (e.shiftKey) this.ui.help.hidden = !this.ui.help.hidden;
          break;
        default: return;
      }
      e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      input.keyUp(e.code); // even if focus moved since the keydown, or the key would stick
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      input.reset();
    });
  }

  private bindToolbar(): void {
    const actions: Record<string, () => void> = {
      translate: () => this.setMode('translate'),
      rotate: () => this.setMode('rotate'),
      scale: () => this.setMode('scale'),
      snap: () => {
        this.gizmo.snap = !this.gizmo.snap;
        this.updateToolbar();
      },
      play: () => this.togglePlay(),
      undo: () => {
        this.history.undo();
        this.hierarchy.markDirty();
      },
      redo: () => {
        this.history.redo();
        this.hierarchy.markDirty();
      },
      duplicate: () => this.duplicateSelected(),
      delete: () => this.deleteSelected(),
      focus: () => this.focusSelected(),
      grid: () => {
        this.engine.showGrid = !this.engine.showGrid;
        this.updateToolbar();
      },
      helpers: () => {
        this.showHelpers = !this.showHelpers;
        this.updateToolbar();
      },
      'camera-view': () => this.setCameraView(!this.cameraView),
      import: () => this.pickFiles(),
      'new-project': () => void this.project.newProject(),
      'open-project': () => void this.project.open(),
      'save-project': () => void this.project.save(),
      'save-project-as': () => void this.project.save(true),
      'new-scene': () => void this.project.newScene(),
      help: () => (this.ui.help.hidden = !this.ui.help.hidden),
      'view-scene': () => this.setView('scene'),
      'view-scripts': () => this.setView('scripts'),
      'add-cube': () => this.createPrimitive('cube'),
      'add-sphere': () => this.createPrimitive('sphere'),
      'add-plane': () => this.createPrimitive('plane'),
      'add-cylinder': () => this.createPrimitive('cylinder'),
      'add-torus': () => this.createPrimitive('torus'),
      'add-empty': () => this.createEmpty(),
      'add-point': () => this.createLight('point'),
      'add-spot': () => this.createLight('spot'),
      'add-directional': () => this.createLight('directional'),
      'add-camera': () => this.createCamera(),
    };
    const root = document.body;
    root.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (!btn) return;
      const action = actions[btn.dataset.action!];
      if (!action) return;
      action();
      // Close dropdown menus after choosing an entry.
      btn.closest('details')?.removeAttribute('open');
      btn.blur();
    });
    const sceneSelect = this.ui.toolbar.querySelector<HTMLSelectElement>('.scene-select');
    sceneSelect?.addEventListener('change', () => {
      void this.project.switchScene(sceneSelect.value);
      sceneSelect.blur();
    });
    // Close open dropdown menus when clicking anywhere else.
    document.addEventListener('pointerdown', (e) => {
      for (const d of document.querySelectorAll('details.menu[open]')) if (!d.contains(e.target as Node)) d.removeAttribute('open');
    });
    this.ui.help.addEventListener('click', (e) => {
      if (e.target === this.ui.help) this.ui.help.hidden = true;
    });
  }

  private bindImport(): void {
    const input = this.ui.importInput;
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      input.value = '';
      void this.importFiles(files);
    });
    const vp = this.ui.viewport;
    let depth = 0;
    vp.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      depth++;
      this.ui.dropOverlay.hidden = false;
    });
    vp.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) this.ui.dropOverlay.hidden = true;
    });
    vp.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    });
    vp.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      this.ui.dropOverlay.hidden = true;
      void this.importFiles(Array.from(e.dataTransfer?.files ?? []));
    });
  }

  private updateToolbar(): void {
    const tb = this.ui.toolbar;
    const set = (action: string, on: boolean) => tb.querySelector(`[data-action="${action}"]`)?.classList.toggle('active', on);
    set('translate', this.gizmo.mode === 'translate');
    set('rotate', this.gizmo.mode === 'rotate');
    set('scale', this.gizmo.mode === 'scale');
    set('snap', this.gizmo.snap);
    set('grid', this.engine.showGrid);
    set('helpers', this.showHelpers);
    set('camera-view', this.cameraView);
    set('play', this.engine.playing);
    set('view-scene', this.view === 'scene');
    set('view-scripts', this.view === 'scripts');
    const broken = this.scene.scripts.scripts.filter((s) => s.diagnostics.length > 0).length;
    const badge = tb.querySelector<HTMLElement>('[data-action="view-scripts"] .tab-badge');
    if (badge) {
      badge.textContent = broken ? String(broken) : '';
      badge.title = broken ? `${broken} script${broken > 1 ? 's have' : ' has'} problems` : '';
    }
    const play = tb.querySelector<HTMLElement>('[data-action="play"]');
    if (play) play.textContent = this.engine.playing ? '■ Stop' : '▶ Play';
    const undo = tb.querySelector<HTMLButtonElement>('[data-action="undo"]');
    const redo = tb.querySelector<HTMLButtonElement>('[data-action="redo"]');
    if (undo) undo.disabled = !this.history.canUndo;
    if (redo) redo.disabled = !this.history.canRedo;

    const pm = this.project;
    document.title = `${pm.dirty ? '• ' : ''}${pm.project.name} — Messier`;
    tb.querySelector('.file-menu')?.classList.toggle('dirty', pm.dirty);
    const select = tb.querySelector<HTMLSelectElement>('.scene-select');
    if (select) {
      const scenes = pm.project.scenes;
      const same = select.options.length === scenes.length && scenes.every((s, i) => select.options[i].value === s.id && select.options[i].text === s.name);
      if (!same) select.replaceChildren(...scenes.map((s) => new Option(s.name, s.id)));
      select.value = pm.sceneId;
      select.disabled = this.engine.playing;
    }
  }

  notify(message: string, kind: 'info' | 'success' | 'error' = 'info'): void {
    const toast = document.createElement('div');
    toast.className = `toast toast-${kind}`;
    toast.textContent = message;
    this.ui.toasts.append(toast);
    setTimeout(() => {
      toast.classList.add('fade');
      setTimeout(() => toast.remove(), 400);
    }, kind === 'error' ? 6000 : 2800);
  }
}

/** Valid script names: letters, digits and underscores, starting with a letter. */
function sanitizeScriptName(name: string): string {
  const words = name.trim().replace(/\.ts$/i, '').split(/[^A-Za-z0-9_]+/).filter(Boolean);
  const joined = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  return /^[0-9]/.test(joined) ? `Script${joined}` : joined;
}

function identifierFor(name: string): string {
  return sanitizeScriptName(name) || 'NewScript';
}

function scriptTemplate(className: string): string {
  return `import { Script, quat } from 'messier';

/** Spins the object around its Y axis. */
export default class ${className} extends Script {
  /** Degrees per second. Public number fields show up in the inspector. */
  speed = 90;

  start(): void {
    // Called once when Play starts.
  }

  update(dt: number, time: number): void {
    const t = this.object.transform;
    t.rotation = quat.multiply(t.rotation, quat.fromEulerDeg(0, this.speed * dt, 0));
  }
}
`;
}

function loadStoredScripts(): { name: string; source: string }[] {
  try {
    const raw = localStorage.getItem(LEGACY_SCRIPTS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((s) => typeof s?.name === 'string' && typeof s?.source === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Finds the position of a JavaScript syntax error. Function() reports none, but
 * an inline script element does, through the window error event (cancelled so
 * it doesn't reach the console). The code is wrapped in a function that never runs.
 */
function locateSyntaxError(code: string): { line: number; column: number } | null {
  let found: { line: number; column: number } | null = null;
  const onError = (e: ErrorEvent) => {
    found = { line: e.lineno, column: e.colno };
    e.preventDefault();
  };
  window.addEventListener('error', onError);
  try {
    const s = document.createElement('script');
    s.textContent = `(function(){${code}\n})`;
    document.head.append(s);
    s.remove();
  } finally {
    window.removeEventListener('error', onError);
  }
  return found;
}

function formatCount(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

interface SelectionPaths {
  items: number[][];
  active: number[] | null;
}

/** Child indices from the scene root down to `obj` (null for no object or a detached one). */
function pathOf(obj: GameObject | null): number[] | null {
  if (!obj?.scene) return null;
  const path: number[] = [];
  for (let o: GameObject = obj; o.parent; o = o.parent) path.unshift(o.parent.children.indexOf(o));
  return path;
}

function objectAt(root: GameObject, path: number[]): GameObject | null {
  let o: GameObject | undefined = root;
  for (const i of path) o = o?.children[i];
  return o && o !== root ? o : null;
}
