import {
  GameObject,
  Light,
  Material,
  Transform,
  getPrimitive,
  loadModelsFromFiles,
  raySphere,
  raycastScene,
  vec3,
  worldBounds,
  boxCorners,
  type Engine,
  type FrameInfo,
  type LightType,
  type PrimitiveKind,
  type Ray,
  type RenderStats,
  type Vec3,
  type Vec4,
} from '../engine';
import { Gizmo, type GizmoMode, type Handle } from './gizmo';
import { History } from './history';
import { HierarchyPanel } from './hierarchy';
import { InspectorPanel } from './inspector';
import { OrbitControls } from './orbitControls';

type PointerMode = 'none' | 'click' | 'orbit' | 'pan' | 'gizmo' | 'fly';

interface PlaySnapshot {
  transform: Transform;
  lightColor?: Vec3;
  lightIntensity?: number;
}

const SELECTION_COLOR: Vec4 = [1, 0.62, 0.15, 0.9];
const LIGHT_ICON_PX = 7;
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
}

/** Real-time scene editor: selection, gizmos, panels, undo/redo, play mode, import. */
export class Editor {
  readonly scene;
  readonly camera;
  readonly controls: OrbitControls;
  readonly gizmo: Gizmo;
  readonly history = new History();
  readonly hierarchy: HierarchyPanel;
  readonly inspector: InspectorPanel;
  selected: GameObject | null = null;
  showHelpers = true;

  private pointerMode: PointerMode = 'none';
  private pointerStart: [number, number] = [0, 0];
  private pointerLast: [number, number] = [0, 0];
  private readonly keys = new Set<string>();
  private transformBefore: Transform | null = null;
  private playSnapshot: Map<GameObject, PlaySnapshot> | null = null;
  private lastStats: RenderStats | null = null;
  private statsTimer = 0;

  constructor(
    readonly engine: Engine,
    private readonly ui: EditorElements,
  ) {
    this.scene = engine.scene;
    this.camera = engine.camera;
    this.controls = new OrbitControls(this.camera);
    this.gizmo = new Gizmo(this.camera);
    this.hierarchy = new HierarchyPanel(this, ui.hierarchy);
    this.inspector = new InspectorPanel(this, ui.inspector);
    this.history.onChange = () => this.updateToolbar();

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

  select(obj: GameObject | null): void {
    if (this.selected === obj) return;
    this.selected = obj;
    this.gizmo.hover = null;
    this.hierarchy.updateSelection();
    this.inspector.show(obj);
  }

  /** Adds an object to the scene as an undoable action and selects it. */
  addObject(obj: GameObject, parent: GameObject = this.scene.root, label = `Add ${obj.name}`): GameObject {
    parent.add(obj);
    const index = parent.children.indexOf(obj);
    this.history.push({
      label,
      undo: () => {
        parent.remove(obj);
        if (this.selected === obj || (this.selected && obj.isAncestorOf(this.selected))) this.select(null);
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
    const oldTransform = obj.transform.clone();
    obj.setParentKeepWorld(parent);
    const newTransform = obj.transform.clone();
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
    obj.transform.copyFrom(new Transform());
    this.commitTransformEdit(obj);
  }

  /** Snapshot taken at the start of a gizmo drag or inspector edit. */
  beginTransformEdit(obj: GameObject): void {
    this.transformBefore = obj.transform.clone();
  }

  commitTransformEdit(obj: GameObject): void {
    const before = this.transformBefore;
    this.transformBefore = null;
    if (!before) return;
    const after = obj.transform.clone();
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

  focusSelected(): void {
    const obj = this.selected;
    if (!obj) {
      this.controls.focus([0, 0.5, 0], 4);
      return;
    }
    obj.updateWorldMatrix(obj.parent?.computeWorldMatrix() ?? null);
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
    if (files.length === 0) return;
    this.notify(`Importing ${files.map((f) => f.name).join(', ')}…`);
    try {
      const models = await loadModelsFromFiles(files);
      for (const model of models) {
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
    model.updateWorldMatrix(null);
    const b = worldBounds(model);
    if (!b) return;
    const size = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    if (size > 0 && (size > 40 || size < 0.05)) {
      const s = 3 / size;
      model.transform.scale = vec3.scale(model.transform.scale, s);
      this.notify(`${model.name}: rescaled ×${s.toPrecision(3)} to fit the scene`);
    }
    // Rest the model on the ground.
    model.updateWorldMatrix(null);
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
    const snap = new Map<GameObject, PlaySnapshot>();
    this.scene.traverse((o) => {
      snap.set(o, {
        transform: o.transform.clone(),
        lightColor: o.light ? vec3.clone(o.light.color) : undefined,
        lightIntensity: o.light?.intensity,
      });
    });
    this.playSnapshot = snap;
    this.scene.traverse((o) => {
      for (const b of o.behaviours) b.start(o);
    });
    this.engine.setPlaying(true);
    document.body.classList.add('playing');
    this.updateToolbar();
  }

  stopPlay(): void {
    if (!this.engine.playing) return;
    this.engine.setPlaying(false);
    for (const [o, s] of this.playSnapshot ?? []) {
      o.transform.copyFrom(s.transform);
      if (o.light && s.lightColor) o.light.color = s.lightColor;
      if (o.light && s.lightIntensity !== undefined) o.light.intensity = s.lightIntensity;
    }
    this.playSnapshot = null;
    document.body.classList.remove('playing');
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
    if (this.selected && !this.isInScene(this.selected)) this.select(null);

    this.hierarchy.update();
    this.inspector.sync();
    this.buildOverlay();

    this.statsTimer += f.dt;
    if (this.statsTimer > 0.25 && this.lastStats) {
      this.statsTimer = 0;
      const s = this.lastStats;
      this.ui.stats.textContent = `${this.engine.fps.toFixed(0)} fps · ${s.drawCalls} draws · ${formatCount(s.triangles)} tris · ${s.lights} lights${
        s.shadowCasters ? ` · ${s.shadowCasters} shadow casters` : ''
      }`;
    }
  }

  private isInScene(obj: GameObject): boolean {
    let o: GameObject | null = obj;
    while (o && o !== this.scene.root) o = o.parent;
    return o === this.scene.root;
  }

  private visibleLights(): GameObject[] {
    const out: GameObject[] = [];
    this.scene.traverse((o) => {
      if (!o.visible) return false;
      if (o.light) out.push(o);
    });
    return out;
  }

  private buildOverlay(): void {
    const overlay = this.engine.overlay;
    const vh = this.ui.canvas.clientHeight;
    if (this.showHelpers) {
      for (const o of this.visibleLights()) {
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
    const sel = this.selected;
    if (sel) {
      const b = worldBounds(sel);
      if (b) overlay.wireBox(boxCorners(b.min, b.max), SELECTION_COLOR, 1.5, true);
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

  /** Object under the cursor: light icons first, then meshes. */
  private pickObject(x: number, y: number): GameObject | null {
    const ray = this.rayAt(x, y);
    if (this.showHelpers) {
      let bestLight: GameObject | null = null;
      let bestT = Infinity;
      for (const o of this.visibleLights()) {
        const pos: Vec3 = [o.worldMatrix[12], o.worldMatrix[13], o.worldMatrix[14]];
        const r = this.engine.overlay.pixelSize(pos) * LIGHT_ICON_PX * 1.6;
        const t = raySphere(ray.origin, ray.dir, pos, r);
        if (t !== null && t < bestT) {
          bestT = t;
          bestLight = o;
        }
      }
      if (bestLight) return bestLight;
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
          const h = this.pickGizmo(x, y);
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
      if (this.pointerMode === 'click') this.select(this.pickObject(x, y));
      this.endActiveGesture();
      canvas.style.cursor = '';
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);

    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const scale = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
        this.controls.zoom(e.deltaY * scale);
      },
      { passive: false },
    );
  }

  private bindKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, select, textarea')) return;
      this.keys.add(e.code);
      if (this.pointerMode === 'fly') return; // WASD flies the camera
      const mod = e.ctrlKey || e.metaKey;
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
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
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
      import: () => this.ui.importInput.click(),
      help: () => (this.ui.help.hidden = !this.ui.help.hidden),
      'add-cube': () => this.createPrimitive('cube'),
      'add-sphere': () => this.createPrimitive('sphere'),
      'add-plane': () => this.createPrimitive('plane'),
      'add-cylinder': () => this.createPrimitive('cylinder'),
      'add-torus': () => this.createPrimitive('torus'),
      'add-empty': () => this.createEmpty(),
      'add-point': () => this.createLight('point'),
      'add-spot': () => this.createLight('spot'),
      'add-directional': () => this.createLight('directional'),
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
    set('play', this.engine.playing);
    const play = tb.querySelector<HTMLElement>('[data-action="play"]');
    if (play) play.textContent = this.engine.playing ? '■ Stop' : '▶ Play';
    const undo = tb.querySelector<HTMLButtonElement>('[data-action="undo"]');
    const redo = tb.querySelector<HTMLButtonElement>('[data-action="redo"]');
    if (undo) undo.disabled = !this.history.canUndo;
    if (redo) redo.disabled = !this.history.canRedo;
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

function formatCount(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}
