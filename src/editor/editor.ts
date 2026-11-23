import {
  AudioClip,
  AudioSource,
  SFX_PRESETS,
  audio,
  type Texture,
  type TextureSlot,
  CameraComponent,
  DEG2RAD,
  draw2d,
  pickScreen2D,
  Renderer2D,
  Shape2D,
  Text2D,
  type ShapeKind2D,
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
  SCENE_EXTENSION,
  deserializeObject,
  instantiatePrefab,
  prefabDependencies,
  prefabFromObject,
  readPrefab,
  serializeObject,
  unpackInstance,
  type Asset,
  type NodeData,
  raySphere,
  raycastScene,
  quat,
  sceneManager,
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
  type Quat,
  type Vec3,
  type Vec4,
} from '../engine';
import { Gizmo, type GizmoMode, type Handle } from './gizmo';
import { History } from './history';
import { Selection } from './selection';
import { ObjectActions } from './objectActions';
import { ContextMenu, type MenuEntry, type MenuItem } from './contextMenu';
import { HierarchyPanel } from './hierarchy';
import { InspectorPanel } from './inspector';
import { OrbitControls } from './orbitControls';
import { LEGACY_SCRIPTS_KEY, ProjectManager, kindOf } from './project';
import { canPickFolders } from './folderIO';
import { ASSET_MIME, AssetsPanel } from './assets';
import { ScriptsView } from './scriptsView';
import { BuildDialog } from './build';
import { ProfilerPanel } from './profilerPanel';

type PointerMode = 'none' | 'click' | 'orbit' | 'pan' | 'gizmo' | 'drag2d' | 'fly';
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
const MUTED_KEY = 'messier.muted';

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
  readonly assets: AssetsPanel;
  readonly inspector: InspectorPanel;
  readonly scripts: ScriptsView;
  readonly project: ProjectManager;
  /** File → Build: which scenes go in a game, and the export. */
  readonly build: BuildDialog;
  /** The viewport's profiler overlay (F2). */
  readonly profiler = new ProfilerPanel();
  /** What's selected (hierarchy, inspector and viewport share it). */
  readonly selection = new Selection();
  /** Hierarchy editing (create, cut/copy/paste, duplicate, delete, visibility) on the selection. */
  readonly actions: ObjectActions;
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
    this.assets = new AssetsPanel(this);
    ui.hierarchy.closest('.panel')?.append(this.assets.root);
    this.inspector = new InspectorPanel(this, ui.inspector);
    this.scripts = new ScriptsView(this, ui.scriptsView);
    this.history.onChange = () => this.updateToolbar();
    this.selection.changed.connect(() => this.selectionChanged());
    const editor = this;
    this.actions = new ObjectActions({
      get scene() {
        return editor.scene;
      },
      get history() {
        return editor.history;
      },
      selection: this.selection,
      objectsChanged: () => this.hierarchy.markDirty(),
    });
    this.project = new ProjectManager(this);
    this.project.onAssetsChange = () => this.assets.markDirty();
    // Toolbar only: rebuilding the inspector here would steal focus from a field being edited.
    this.project.onChange = () => {
      this.updateToolbar();
      if (this.build?.isOpen) this.build.refresh();
    };
    this.build = new BuildDialog(this);
    document.body.append(this.build.root);
    ui.viewport.append(this.profiler.root);
    this.initScripts();
    sceneManager.onWarning = (message) => this.notify(message, 'error');
    // A script loaded another scene during Play: show that one. (Play and Stop switch scenes while not playing.)
    engine.sceneChanged.connect(() => {
      if (!engine.playing) return;
      this.endActiveGesture();
      this.history.clear();
      this.prewarm();
      this.sceneSwitched({ items: [], active: null });
    });

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
    return this.actions.add(obj, parent, label);
  }

  /** Deletes the selected objects (one undo step). */
  deleteSelected(): void {
    this.actions.delete();
  }

  /** Duplicates the selected objects, each copy right after its original (one undo step). */
  duplicateSelected(): void {
    this.actions.duplicate();
  }

  undo(): void {
    this.history.undo();
    this.hierarchy.markDirty();
  }

  redo(): void {
    this.history.redo();
    this.hierarchy.markDirty();
  }

  /**
   * Opens the hierarchy's context menu at client coordinates. `target` is the object under the cursor (null over
   * empty space): right-clicking an unselected object selects just it, a selected one keeps the selection.
   */
  openHierarchyMenu(target: GameObject | null, x: number, y: number): ContextMenu {
    if (target && !this.selection.has(target)) this.select(target);
    const a = this.actions;
    const has = () => a.hasSelection;
    // Over an object, new objects become its children; over empty space they go to the root.
    const parent = target ?? undefined;
    const create = (label: string, make: (p?: GameObject) => GameObject): MenuItem => ({ label, action: () => make(parent) });
    const entries: MenuEntry[] = [
      { label: 'Undo', shortcut: 'Mod+Z', enabled: () => this.history.canUndo, action: () => this.undo() },
      { label: 'Redo', shortcut: 'Mod+Shift+Z', enabled: () => this.history.canRedo, action: () => this.redo() },
      'separator',
      {
        label: 'Create',
        children: [
          create('Empty', (p) => this.createEmpty(p)),
          'separator',
          create('Cube', (p) => this.createPrimitive('cube', p)),
          create('Sphere', (p) => this.createPrimitive('sphere', p)),
          create('Plane', (p) => this.createPrimitive('plane', p)),
          create('Cylinder', (p) => this.createPrimitive('cylinder', p)),
          create('Torus', (p) => this.createPrimitive('torus', p)),
          'separator',
          create('Point Light', (p) => this.createLight('point', p)),
          create('Spot Light', (p) => this.createLight('spot', p)),
          create('Directional Light', (p) => this.createLight('directional', p)),
          'separator',
          create('Camera', (p) => this.createCamera(p)),
          'separator',
          create('Rectangle', (p) => this.createShape2D('rectangle', p)),
          create('Ellipse', (p) => this.createShape2D('ellipse', p)),
          create('Polygon', (p) => this.createShape2D('polygon', p)),
          create('Text', (p) => this.createText2D(false, p)),
          create('Screen Text (HUD)', (p) => this.createText2D(true, p)),
        ],
      },
      'separator',
      { label: 'Cut', shortcut: 'Mod+X', enabled: has, action: () => a.cut() },
      { label: 'Copy', shortcut: 'Mod+C', enabled: has, action: () => a.copy() },
      { label: 'Paste', shortcut: 'Mod+V', enabled: () => a.canPaste, action: () => a.paste() },
      { label: 'Paste as Child', shortcut: 'Mod+Shift+V', enabled: () => a.canPaste && !!this.selected, action: () => a.paste(true) },
      'separator',
      { label: 'Duplicate', shortcut: 'Mod+D', enabled: has, action: () => a.duplicate() },
      { label: 'Delete', shortcut: 'Delete', enabled: has, action: () => a.delete() },
      'separator',
      { label: 'Visible', checked: () => a.visibleState() ?? false, enabled: has, action: () => a.toggleVisible() },
    ];
    if (target) entries.push('separator', ...this.prefabMenu(target));
    return ContextMenu.open(entries, x, y);
  }

  /** Context menu entries for prefabs: create one from `obj`, or apply, revert and unpack the instance it's part of. */
  prefabMenu(obj: GameObject): MenuEntry[] {
    const root = this.prefabRootOf(obj);
    const asset = root && this.prefabAsset(root);
    const entries: MenuEntry[] = [{ label: 'Create Prefab', action: () => void this.createPrefab(obj) }];
    if (root && asset) {
      entries.push({ label: `Apply to Prefab "${asset.name}"`, action: () => void this.applyPrefab(root) });
      if (this.isOutermostInstance(root)) {
        entries.push({ label: 'Revert to Prefab', action: () => this.revertPrefab(root) });
      }
    }
    if (root && this.isOutermostInstance(root)) entries.push({ label: 'Unpack Prefab', action: () => this.unpackPrefab(root) });
    return entries;
  }

  /** Selects every object in the scene, in tree order. */
  selectAll(): void {
    const all: GameObject[] = [];
    this.scene.traverse((o) => void all.push(o));
    this.selection.selectAll(all);
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

  /** Imports an image file as a project asset (so scenes using it save). Null, with an error shown, if it fails. */
  async importImage(file: File): Promise<Texture | null> {
    const [asset] = await this.project.importFiles([file]);
    return asset ? this.project.texture(asset.id) : null;
  }

  /** Shows `texture` as the scene's sky. Undoable. */
  setSkyImage(texture: Texture): void {
    const sky = this.scene.sky;
    const before = { mode: sky.mode, texture: sky.texture };
    const apply = (mode: typeof sky.mode, tex: Texture | null) => {
      sky.mode = mode;
      sky.texture = tex;
      if (!this.selected) this.inspector.refresh();
    };
    apply('image', texture);
    this.history.push({ label: `Set the sky to ${texture.name}`, undo: () => apply(before.mode, before.texture), redo: () => apply('image', texture) });
  }

  /** An object with an AudioSource playing a synthesized blip, in front of the view. */
  createAudioSource(parent?: GameObject): GameObject {
    const obj = new GameObject('Audio Source');
    obj.attachComponent(new AudioSource({ clip: AudioClip.synth(SFX_PRESETS.blip, 'blip') }));
    obj.transform.position = this.spawnPoint(0.5);
    return this.addCreated(obj, parent);
  }

  /** Adds or removes an object's AudioSource. Undoable. */
  setAudioSource(obj: GameObject, on: boolean): void {
    const existing = obj.getComponent(AudioSource);
    if (on === !!existing) return;
    const source = existing ?? new AudioSource({ clip: AudioClip.synth(SFX_PRESETS.blip, 'blip') });
    const index = existing ? obj.components.indexOf(existing) : obj.components.length;
    const apply = (attach: boolean) => {
      if (attach && !source.attached) obj.attachComponent(source, index);
      else if (!attach && source.attached) obj.detachComponent(source);
      if (this.selected === obj) this.inspector.refresh();
      this.hierarchy.markDirty();
    };
    apply(on);
    const label = `${on ? 'Add audio source to' : 'Remove audio source from'} ${obj.name}`;
    this.history.push({ label, undo: () => apply(!on), redo: () => apply(on) });
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

  /**
   * Takes a script's source from outside the editor (its file changed on disk): replaces and compiles it, or adds a
   * new script. Running objects pick up the new class, as when typing in the Scripts tab.
   */
  applyScriptSource(name: string, source: string): void {
    const lib = this.scene.scripts;
    const asset = lib.get(name);
    if (asset?.source === source) return;
    if (asset) {
      const unsaved = this.scripts.current === asset && asset.source !== asset.compiledSource;
      asset.source = source;
      this.compileScript(asset);
      this.scripts.reloadSource(asset);
      if (unsaved) this.notify(`${name}.ts changed on disk; the editor now shows that version`, 'error');
    } else {
      this.compileScript(lib.add(new ScriptAsset(name, source)));
      this.scriptsChanged();
    }
  }

  /** Removes a script whose file was deleted on disk, detaching it from objects (undoable, like Delete). */
  removeScriptNamed(name: string): void {
    const asset = this.scene.scripts.get(name);
    if (asset) this.deleteScript(asset);
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
    this.prewarm();
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

  /**
   * The create* functions add at the scene root in front of the camera, or with `parent` at its local origin.
   * Undoable; the new object is selected.
   */
  createPrimitive(kind: PrimitiveKind, parent?: GameObject): GameObject {
    const names: Record<PrimitiveKind, string> = { cube: 'Cube', sphere: 'Sphere', plane: 'Plane', cylinder: 'Cylinder', torus: 'Torus' };
    const obj = new GameObject(names[kind]);
    obj.mesh = getPrimitive(kind);
    obj.material = new Material(`${names[kind]} material`, { baseColor: [0.8, 0.8, 0.8, 1], roughness: 0.5 });
    obj.transform.position = this.spawnPoint(kind === 'plane' ? 0 : 0.5);
    return this.addCreated(obj, parent);
  }

  createLight(type: LightType, parent?: GameObject): GameObject {
    const names: Record<LightType, string> = { directional: 'Directional Light', point: 'Point Light', spot: 'Spot Light' };
    const obj = new GameObject(names[type]);
    obj.light = new Light(type);
    if (type === 'spot') obj.light.range = 15;
    obj.transform.position = this.spawnPoint(type === 'directional' ? 4 : 2.5);
    if (type !== 'point') obj.transform.setEulerDeg(-60, 30, 0);
    if (type === 'directional') obj.light.castShadows = !this.scene.find((o) => !!o.light?.castShadows);
    return this.addCreated(obj, parent);
  }

  /** Adds a camera on the ground in front of the view, looking the way the editor camera does. */
  createCamera(parent?: GameObject): GameObject {
    const obj = new GameObject('Camera');
    obj.camera = new CameraComponent();
    obj.transform.position = this.spawnPoint(1.5);
    obj.transform.rotation = quat.lookRotation(this.camera.forward());
    return this.addCreated(obj, parent);
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

  /** A world-space 2D shape standing upright in front of the view, facing it. */
  createShape2D(kind: Exclude<ShapeKind2D, 'path'>, parent?: GameObject): GameObject {
    const names: Record<typeof kind, string> = { rectangle: 'Rectangle', ellipse: 'Ellipse', polygon: 'Polygon' };
    const colors: Record<typeof kind, Vec4> = { rectangle: [0.95, 0.55, 0.25, 1], ellipse: [0.3, 0.75, 0.95, 1], polygon: [0.55, 0.85, 0.4, 1] };
    const obj = new GameObject(names[kind]);
    obj.attachComponent(new Shape2D({
      shape: kind,
      fillColor: colors[kind],
      strokeWidth: 0.04,
      strokeColor: [0.08, 0.08, 0.1, 1],
      cornerRadius: kind === 'rectangle' ? 0.1 : 0,
    }));
    this.placeFacingView(obj, 0.5);
    return this.addCreated(obj, parent);
  }

  /** World-space text in front of the view, or (`screen`) a HUD label near the top-left corner of the viewport. */
  createText2D(screen: boolean, parent?: GameObject): GameObject {
    const obj = new GameObject(screen ? 'Screen Text' : 'Text');
    if (screen) {
      obj.attachComponent(new Text2D({
        space: 'screen', anchor: 'top-left', text: 'Screen Text', fontSize: 28, align: 'left', verticalAlign: 'top', outlineWidth: 2,
      }));
      // Pixels from the anchor, y up: 16 px in from the corner.
      obj.transform.position = [16, -16, 0];
      return this.addObject(obj, parent);
    }
    obj.attachComponent(new Text2D({ text: 'Text', fontSize: 0.5 }));
    this.placeFacingView(obj, 0.5);
    return this.addCreated(obj, parent);
  }

  private placeFacingView(obj: GameObject, height: number): void {
    obj.transform.position = this.spawnPoint(height);
    const f = this.camera.forward();
    // Upright, with +Z (the side 2D renderers face) toward the camera.
    if (Math.hypot(f[0], f[2]) > 1e-3) obj.transform.rotation = quat.lookRotation(vec3.normalize([f[0], 0, f[2]]));
  }

  /** Whether the object draws in screen space (and so has no gizmo in the 3D view). */
  isScreenSpace(obj: GameObject | null): boolean {
    const r = obj?.getComponent(Renderer2D);
    return !!r && r.space === 'screen' && !obj!.mesh;
  }

  createEmpty(parent?: GameObject): GameObject {
    const obj = new GameObject('Empty');
    obj.transform.position = this.spawnPoint(0);
    return this.addCreated(obj, parent);
  }

  private addCreated(obj: GameObject, parent?: GameObject): GameObject {
    if (!parent) return this.addObject(obj);
    // A child starts at its parent's origin, keeping its own orientation (lights point down, cameras ahead).
    obj.transform.position = [0, 0, 0];
    obj.transform.rotation = quat.normalize(quat.multiply(quat.invert(parent.worldRotation()), obj.transform.rotation));
    return this.addObject(obj, parent);
  }

  /** Point on the ground plane in front of the camera. */
  private spawnPoint(height: number): Vec3 {
    const t = this.camera.target;
    return [Math.round(t[0] * 2) / 2, height, Math.round(t[2] * 2) / 2];
  }

  /**
   * Imports dropped or picked files: .messier files open (a scene joins the project; an old single-file project
   * opens), scripts join the Scripts tab, and models, images and sounds become project assets (in a folder project,
   * copied into assets/) and are placed: models and sounds in front of the view, an image on its own as the sky.
   */
  async importFiles(files: File[]): Promise<void> {
    for (const f of files.filter((f) => f.name.toLowerCase().endsWith(SCENE_EXTENSION))) await this.project.openFile(f);
    files = files.filter((f) => !f.name.toLowerCase().endsWith(SCENE_EXTENSION));
    const scripts = files.filter((f) => /\.ts$/i.test(f.name));
    files = files.filter((f) => !scripts.includes(f));
    let lastScript: ScriptAsset | null = null;
    for (const f of scripts) {
      lastScript = this.createScript(f.name.replace(/\.ts$/i, ''), await f.text());
      this.notify(`Imported script ${lastScript.name}.ts`, 'success');
    }
    if (lastScript) this.setView('scripts', lastScript);
    if (files.length === 0) return;
    const assets = await this.project.importFiles(files);
    const placed: GameObject[] = [];
    for (const asset of assets) {
      if (kindOf(asset) === 'image') {
        // Images on their own (no model they could belong to) become the sky: a 2:1 panorama is what skies take.
        const texture = this.project.texture(asset.id);
        if (!texture) continue;
        this.setSkyImage(texture);
        const { width, height } = texture.source;
        const shape = Math.abs(width / height - 2) < 0.1 ? '' : ` It's ${width}×${height}; a sky image should be a 2:1 panorama.`;
        this.notify(`${asset.name} is now the sky.${shape}`, shape ? 'error' : 'success');
        continue;
      }
      const obj = this.placeAsset(asset);
      if (obj) {
        placed.push(obj);
        this.notify(`Imported ${asset.name}`, 'success');
      }
    }
    if (placed.length) this.focusSelected();
  }

  /**
   * An asset dragged from the Assets panel onto the viewport: a model or sound is placed where the pointer points
   * (on the surface under it, else on the ground); an image becomes the texture of the object under the pointer, or
   * the sky when there's none.
   */
  private dropAsset(assetId: string, e: DragEvent): void {
    const asset = this.project.assets.find((a) => a.id === assetId);
    if (!asset || this.engine.viewObject) return;
    const [x, y] = this.localPointer(e);
    const c = this.ui.canvas;
    const ray = this.camera.screenRay(x, y, c.clientWidth, c.clientHeight);
    const hit = raycastScene(this.scene, ray);
    if (kindOf(asset) === 'image') {
      const texture = this.project.texture(asset.id);
      if (!texture) return;
      if (hit?.object.material) this.setTexture(hit.object, texture);
      else this.setSkyImage(texture);
      return;
    }
    let at: Vec3 | undefined = hit?.point;
    if (!at && Math.abs(ray.dir[1]) > 1e-4) {
      const t = -ray.origin[1] / ray.dir[1];
      if (t > 0) at = vec3.addScaled(ray.origin, ray.dir, t);
    }
    if (this.placeAsset(asset, at)) this.focusSelected();
  }

  /** Gives an object's material a texture (its base color's, or another slot's). Undoable. */
  setTexture(obj: GameObject, texture: Texture | null, slot: TextureSlot = 'baseColorTexture'): void {
    const mat = obj.material;
    if (!mat) return;
    const before = { texture: mat[slot], emissive: [...mat.emissive] as Vec3 };
    // An emissive map multiplies the emissive color, so a black one would hide it.
    const emissive: Vec3 = slot === 'emissiveTexture' && texture && before.emissive.every((c) => c === 0) ? [1, 1, 1] : before.emissive;
    const apply = (t: Texture | null, e: Vec3) => {
      mat[slot] = t;
      mat.emissive = [...e];
      if (this.selected === obj) this.inspector.refresh();
    };
    apply(texture, emissive);
    this.history.push({ label: `Texture ${obj.name}`, undo: () => apply(before.texture, before.emissive), redo: () => apply(texture, emissive) });
    this.notify(`${texture?.name ?? 'No texture'} on ${obj.name}`, 'success');
  }

  /**
   * Adds an object for a model or sound asset to the scene (at `position`, or in front of the view; under `parent`).
   * Undoable. Returns null for assets that aren't placed as objects (images, other files).
   */
  placeAsset(asset: Asset, position?: Vec3, parent: GameObject = this.scene.root): GameObject | null {
    const kind = kindOf(asset);
    let obj: GameObject | null = null;
    if (kind === 'model') {
      obj = this.project.instantiateModel(asset.id);
      if (!obj) {
        this.notify(`${asset.name} didn't load, so it can't be placed`, 'error');
        return null;
      }
      this.normalizeImportedScale(obj);
      if (parent !== this.scene.root) obj.transform.position = [0, 0, 0];
      else obj.transform.position = vec3.add(obj.transform.position, position ?? this.spawnPoint(0));
    } else if (kind === 'prefab') {
      const warnings: string[] = [];
      obj = instantiatePrefab(asset.id, this.scene, this.project.prefabs, warnings);
      if (!obj) {
        this.notify(`${asset.name} can't be read, so it can't be placed`, 'error');
        return null;
      }
      obj.transform.position = parent !== this.scene.root ? [0, 0, 0] : (position ?? this.spawnPoint(0));
      for (const w of warnings) this.notify(w, 'error');
    } else if (kind === 'sound') {
      const clip = this.project.audioClip(asset.id);
      if (!clip) {
        this.notify(`${asset.name} didn't load, so it can't be placed`, 'error');
        return null;
      }
      obj = new GameObject(asset.name);
      // Not spatial: a dropped sound is usually music or an effect for a script to play.
      obj.attachComponent(new AudioSource({ clip, spatial: false }));
      obj.transform.position = parent !== this.scene.root ? [0, 0, 0] : (position ?? this.spawnPoint(0.5));
    }
    if (!obj) return null;
    this.addObject(obj, parent, `Add ${obj.name}`);
    this.prewarm();
    return obj;
  }

  /** Builds the pipelines the scene needs in the background, so the next frames don't stop to build them. */
  private prewarm(): void {
    this.engine.renderer.prewarm(this.scene).catch((err) => this.notify(`Could not prepare shaders: ${(err as Error).message}`, 'error'));
  }

  // ---------------------------------------------------------------------------
  // Prefabs

  /** The prefab instance `obj` is part of: itself when it's an instance root, else its nearest instance root. */
  prefabRootOf(obj: GameObject): GameObject | null {
    for (let o: GameObject | null = obj; o && o.parent; o = o.parent) {
      if (o.prefab) return o;
      if (o.prefabNode === null) return null;
    }
    return null;
  }

  /** Whether `obj` is an instance root that isn't inside another instance (Revert and Unpack work on those). */
  isOutermostInstance(obj: GameObject): boolean {
    if (!obj.prefab) return false;
    for (let p = obj.parent; p; p = p.parent) if (p.prefab) return false;
    return true;
  }

  /** The prefab asset of an instance root (null when it's missing). */
  prefabAsset(obj: GameObject): Asset | null {
    const asset = obj.prefab ? this.project.project.getAsset(obj.prefab) : null;
    return asset && kindOf(asset) === 'prefab' && !obj._prefabStash ? asset : null;
  }

  private canEditPrefabs(): boolean {
    if (!this.engine.playing) return true;
    this.notify('Stop Play to change prefabs');
    return false;
  }

  /**
   * Saves `obj` and its descendants as a new prefab asset, and turns `obj` into an instance of it (undo turns it
   * back; the asset stays). Instances inside it become nested instances; an instance root makes a variant.
   */
  async createPrefab(obj: GameObject): Promise<Asset | null> {
    if (!this.canEditPrefabs() || !obj.parent) return null;
    const warnings: string[] = [];
    const lib = this.project.prefabs;
    const asset = await this.project.createPrefabAsset(obj.name, prefabFromObject(obj, lib, warnings));
    const instance = deserializeObject({ prefab: asset.id, ...trs(obj) }, this.scene, lib, warnings);
    if (obj.parent) this.replaceObjects([[obj, instance]], `Create prefab ${asset.name}`);
    this.notify(`Created prefab ${asset.name}${warnings.length ? ` (${warnings[0]})` : ''}`, warnings.length ? 'error' : 'success');
    return asset;
  }

  /**
   * Writes an instance's changes into its prefab, and rebuilds the instances in the scene that use the prefab.
   * Undo puts the prefab and the instances back.
   */
  async applyPrefab(obj: GameObject): Promise<void> {
    const asset = this.prefabAsset(obj);
    if (!this.canEditPrefabs() || !asset) return;
    const warnings: string[] = [];
    let data;
    try {
      data = prefabFromObject(obj, this.project.prefabs, warnings, asset.id);
    } catch (err) {
      this.notify(`Can't apply to ${asset.name}: ${(err as Error).message}`, 'error');
      return;
    }
    const before = readPrefab(asset.files[0].bytes);
    const captured = this.captureInstances();
    await this.project.writePrefab(asset, data);
    const pairs = this.rebuildInstances(captured, new Set([asset.id]), true, warnings);
    this.history.push({
      label: `Apply to prefab ${asset.name}`,
      undo: () => {
        void this.project.writePrefab(asset, before);
        this.swapObjects(pairs.map(([a, b]) => [b, a]).reverse() as [GameObject, GameObject][]);
      },
      redo: () => {
        void this.project.writePrefab(asset, data);
        this.swapObjects(pairs);
      },
    });
    this.notify(`Applied to ${asset.name}${warnings.length ? ` (${warnings[0]})` : ''}`, warnings.length ? 'error' : 'success');
  }

  /** Throws away an instance's changes: it becomes a fresh copy of its prefab, keeping its name and transform. Undoable. */
  revertPrefab(obj: GameObject): void {
    const asset = this.prefabAsset(obj);
    if (!this.canEditPrefabs() || !asset || !this.isOutermostInstance(obj)) return;
    const warnings: string[] = [];
    const fresh = deserializeObject({ prefab: asset.id, ...trs(obj) }, this.scene, this.project.prefabs, warnings);
    this.replaceObjects([[obj, fresh]], `Revert ${obj.name}`);
    for (const w of warnings) this.notify(w, 'error');
  }

  /** Makes an instance plain objects (instances nested in it stay instances). Undoable. */
  unpackPrefab(obj: GameObject): void {
    if (!this.canEditPrefabs() || !this.isOutermostInstance(obj)) return;
    let undo = unpackInstance(obj, this.project.prefabs);
    const changed = () => {
      this.hierarchy.markDirty();
      if (this.selected === obj) this.inspector.refresh();
    };
    changed();
    this.history.push({
      label: `Unpack ${obj.name}`,
      undo: () => {
        undo();
        changed();
      },
      redo: () => {
        undo = unpackInstance(obj, this.project.prefabs);
        changed();
      },
    });
  }

  /** How many changes an instance saves (overridden fields, removed and added objects). */
  instanceChanges(obj: GameObject): number {
    const d = serializeObject(obj, this.project.prefabs);
    if (!('prefab' in d)) return 0;
    return Object.values(d.overrides ?? {}).reduce((n, o) => n + Object.keys(o).length, 0) + (d.removed?.length ?? 0) + (d.added?.length ?? 0);
  }

  /** The saved data of every instance in the scene that isn't inside another one, before a prefab changes. */
  captureInstances(): CapturedInstance[] {
    const lib = this.project.prefabs;
    const out: CapturedInstance[] = [];
    this.scene.traverse((o) => {
      if (!o.prefab) return;
      const data = serializeObject(o, lib);
      out.push({ obj: o, data, uses: prefabDependencies(data, lib) });
      return false;
    });
    return out;
  }

  /**
   * After prefabs changed: rebuilds the captured instances that use any of `changed` from their saved data (so they
   * get the new version with their own changes), in place. Without `undoable` the undo history is cleared, since
   * its steps may refer to the replaced objects. Returns the replaced and new objects.
   */
  rebuildInstances(captured: CapturedInstance[], changed: Set<string>, undoable: boolean, warnings: string[] = []): [GameObject, GameObject][] {
    const pairs: [GameObject, GameObject][] = [];
    for (const c of captured) {
      if (!c.obj.parent || ![...c.uses].some((id) => changed.has(id))) continue;
      pairs.push([c.obj, deserializeObject(c.data, this.scene, this.project.prefabs, warnings)]);
    }
    if (!pairs.length) return pairs;
    this.swapObjects(pairs);
    if (!undoable) {
      this.endActiveGesture();
      this.history.clear();
    }
    return pairs;
  }

  /** Replaces objects (and pushes an undo step that swaps them back). */
  private replaceObjects(pairs: [GameObject, GameObject][], label: string): void {
    this.swapObjects(pairs);
    this.history.push({
      label,
      undo: () => this.swapObjects(pairs.map(([a, b]) => [b, a]).reverse() as [GameObject, GameObject][]),
      redo: () => this.swapObjects(pairs),
    });
  }

  /** Puts each pair's second object where its first one is; the selection follows by place in the hierarchy. */
  private swapObjects(pairs: [GameObject, GameObject][]): void {
    const paths = this.selectionPaths();
    for (const [from, to] of pairs) {
      const parent = from.parent;
      if (!parent) continue;
      const index = parent.children.indexOf(from);
      parent.remove(from);
      parent.add(to, index);
    }
    this.hierarchy.markDirty();
    const find = (p: number[] | null) => (p ? objectAt(this.scene.root, p) : null);
    this.selection.setMany(paths.items.map(find).filter((o): o is GameObject => o !== null), find(paths.active));
    this.inspector.show(this.selected, true);
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

  setMuted(muted: boolean): void {
    audio.muted = muted;
    try {
      localStorage.setItem(MUTED_KEY, muted ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
    this.updateToolbar();
  }

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
    // Scripts can load the project's other scenes, by build order (File → Build) like in a built game.
    this.project.flush();
    const pm = this.project;
    const scenes = pm.project.buildScenes();
    sceneManager.attach(
      this.engine,
      { names: scenes.map((s) => s.name), load: (i) => pm.instantiate(scenes[i]) },
      scenes.findIndex((s) => s.id === pm.sceneId),
    );
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
    sceneManager.detach();
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

    this.profiler.update(f.dt, this.lastStats);
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
      if (this.isScreenSpace(o)) {
        this.outlineScreen2D(o, o === this.selected);
        continue;
      }
      const b = worldBounds(o);
      if (b) overlay.wireBox(boxCorners(b.min, b.max), SELECTION_COLOR, o === this.selected ? 1.5 : 1, true);
    }
    const sel = this.selected;
    if (sel) {
      const col = worldCollider(sel);
      if (col?.shape === 'box') overlay.wireBox(colliderCorners(col), COLLIDER_COLOR, 1.5, true);
      else if (col) for (const axis of col.axes) overlay.circle(col.center, axis, col.radius, COLLIDER_COLOR, 1.5, true, 48);
      if (!this.isScreenSpace(sel)) this.gizmo.draw(overlay, sel, vh);
    }
  }

  /** Selection outline of a screen-space object, drawn into the HUD layer. */
  private outlineScreen2D(o: GameObject, active: boolean): void {
    const c = this.ui.canvas;
    for (const r of o.getComponents(Renderer2D)) {
      if (r.space !== 'screen' || !r.isActiveAndEnabled) continue;
      const m = r.targetMatrix(c.clientWidth, c.clientHeight);
      const [x0, y0, x1, y1] = r.localBounds();
      const corners: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      const pts = corners.map(([x, y]): [number, number] => [m[0] * x + m[4] * y + m[12], m[1] * x + m[5] * y + m[13]]);
      draw2d.polyline(pts, SELECTION_COLOR, active ? 1.5 : 1, true);
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
    if (!this.selected || this.isScreenSpace(this.selected)) return null;
    const c = this.ui.canvas;
    return this.gizmo.pick(this.selected, x, y, c.clientWidth, c.clientHeight);
  }

  /** Object under the cursor: light and camera icons first, then meshes. */
  private pickObject(x: number, y: number): GameObject | null {
    const c = this.ui.canvas;
    // The HUD is in front of everything.
    const hud = pickScreen2D(this.scene, x, y, c.clientWidth, c.clientHeight);
    if (hud) return hud.gameObject;
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
    } else if (this.pointerMode === 'drag2d' && this.selected) {
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
        // Dragging the selected HUD element moves it in pixels.
        const hud = e.shiftKey ? null : pickScreen2D(this.scene, x, y, canvas.clientWidth, canvas.clientHeight)?.gameObject;
        if (hud && hud === this.selected) {
          this.pointerMode = 'drag2d';
          this.beginTransformEdit(hud);
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
        case 'drag2d':
          if (this.selected) {
            // Screen space is y up from the anchor; pointer deltas are y down.
            const p = this.selected.worldPosition();
            this.selected.setWorldPosition([p[0] + dx, p[1] - dy, p[2]]);
          }
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

  toggleProfiler(): void {
    this.profiler.setVisible(!this.profiler.visible);
    this.updateToolbar();
  }

  private objectsHaveFocus(): boolean {
    const a = document.activeElement;
    return a === this.ui.canvas || (a instanceof Node && this.ui.hierarchy.contains(a));
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
      if (mod && e.shiftKey && !e.altKey && e.code === 'KeyB') {
        e.preventDefault();
        if (this.build.isOpen) this.build.close();
        else this.build.open();
        return;
      }
      // The profiler is for watching a running game too, so it isn't a plain-key shortcut (those go to scripts).
      if (e.code === 'F2' && !mod && !e.altKey) {
        e.preventDefault();
        this.toggleProfiler();
        return;
      }
      // The build dialog is modal: no scene shortcuts behind it.
      if (this.build.isOpen) {
        if (e.code === 'Escape') this.build.close();
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
        if (e.shiftKey) this.redo();
        else this.undo();
        return;
      }
      if (mod && e.code === 'KeyY') {
        e.preventDefault();
        this.redo();
        return;
      }
      if (mod && e.code === 'KeyD') {
        e.preventDefault();
        this.duplicateSelected();
        return;
      }
      // Clipboard and Select All act on objects only while the hierarchy or the viewport has focus, so Ctrl+C
      // keeps its usual meaning elsewhere (e.g. copying text).
      if (mod && !e.altKey && ['KeyC', 'KeyX', 'KeyV', 'KeyA'].includes(e.code) && this.objectsHaveFocus()) {
        e.preventDefault();
        if (e.code === 'KeyC') this.actions.copy();
        else if (e.code === 'KeyX') this.actions.cut();
        else if (e.code === 'KeyV') this.actions.paste(e.shiftKey);
        else this.selectAll();
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
      profiler: () => this.toggleProfiler(),
      import: () => this.pickFiles(),
      'new-project': () => void this.project.newProject(),
      'open-project': () => void this.project.open(),
      'save-project': () => void this.project.save(),
      'save-project-as': () => void this.project.save(true),
      'download-project': () => void this.project.downloadZip(),
      'export-project': () => void this.project.exportToFolder(),
      'new-scene': () => void this.project.newScene(),
      'delete-scene': () => void this.project.deleteScene(this.project.sceneId),
      'build-settings': () => this.build.open(),
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
      'add-rectangle': () => this.createShape2D('rectangle'),
      'add-ellipse': () => this.createShape2D('ellipse'),
      'add-polygon': () => this.createShape2D('polygon'),
      'add-text': () => this.createText2D(false),
      'add-screen-text': () => this.createText2D(true),
      'add-audio': () => this.createAudioSource(),
      mute: () => this.setMuted(!audio.muted),
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
    // The open scene's name, in the ☰ menu: Enter (or leaving the field) renames, Esc reverts.
    const sceneName = this.ui.toolbar.querySelector<HTMLInputElement>('.scene-name');
    if (sceneName) {
      const current = () => this.project.currentScene?.name ?? '';
      sceneName.addEventListener('change', () => {
        this.project.renameScene(this.project.sceneId, sceneName.value);
        sceneName.value = current(); // blank names are refused
      });
      sceneName.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sceneName.closest('details')?.removeAttribute('open');
        else if (e.key === 'Escape') {
          sceneName.value = current();
          sceneName.blur();
        }
      });
    }
    // Browsers start audio only after the user interacted with the page.
    document.addEventListener('pointerdown', () => audio.resume(), true);
    window.addEventListener('keydown', () => audio.resume(), true);
    try {
      audio.muted = localStorage.getItem(MUTED_KEY) === '1';
    } catch {
      /* storage unavailable */
    }
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
      if (e.dataTransfer?.types.includes('Files') || e.dataTransfer?.types.includes(ASSET_MIME)) e.preventDefault();
    });
    vp.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      this.ui.dropOverlay.hidden = true;
      const assetId = e.dataTransfer?.getData(ASSET_MIME);
      if (assetId) this.dropAsset(assetId, e);
      else void this.importFiles(Array.from(e.dataTransfer?.files ?? []));
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
    set('profiler', this.profiler.visible);
    set('play', this.engine.playing);
    const mute = tb.querySelector<HTMLElement>('[data-action="mute"]');
    if (mute) {
      mute.textContent = audio.muted ? '🔇' : '🔊';
      mute.classList.toggle('active', audio.muted);
    }
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
    const sceneName = tb.querySelector<HTMLInputElement>('.scene-name');
    if (sceneName && document.activeElement !== sceneName) sceneName.value = pm.currentScene?.name ?? '';
    const location = tb.querySelector<HTMLElement>('.project-location');
    if (location) location.textContent = pm.folderName ? `📁 ${pm.folderName}` : 'In this browser';
    const saveAs = tb.querySelector<HTMLButtonElement>('[data-action="save-project-as"]');
    if (saveAs) saveAs.hidden = !canPickFolders();
    const exportTo = tb.querySelector<HTMLButtonElement>('[data-action="export-project"]');
    if (exportTo) exportTo.hidden = !canPickFolders();
    const newScene = tb.querySelector<HTMLButtonElement>('[data-action="new-scene"]');
    const deleteScene = tb.querySelector<HTMLButtonElement>('[data-action="delete-scene"]');
    if (newScene) newScene.disabled = this.engine.playing;
    if (deleteScene) {
      deleteScene.disabled = this.engine.playing || pm.project.scenes.length < 2;
      deleteScene.title = pm.project.scenes.length < 2 ? 'A project needs at least one scene' : `Delete "${pm.currentScene?.name ?? ''}"`;
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

/** An instance's saved data, taken before a prefab changes, and the prefabs it uses. */
export interface CapturedInstance {
  obj: GameObject;
  data: NodeData;
  uses: Set<string>;
}

/** An object's name and local transform, as an instance saves them. */
function trs(obj: GameObject): { name: string; position: Vec3; rotation: Quat; scale: Vec3 } {
  const t = obj.transform;
  return { name: obj.name, position: [...t.position], rotation: [...t.rotation], scale: [...t.scale] };
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
