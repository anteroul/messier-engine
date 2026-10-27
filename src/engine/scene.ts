import { mat4, type Mat4, type Quat, type Vec3 } from './math';
import { Transform } from './transform';
import { Component, type ComponentClass, type ComponentInit, type ComponentType } from './component';
import { MeshRenderer } from './meshRenderer';
import type { Mesh } from './mesh';
import type { Material } from './material';
import { Light } from './light';
import { CameraComponent } from './camera';
import { Behaviour, HOOK_FIXED_UPDATE, HOOK_LATE_UPDATE, HOOK_UPDATE } from './behaviours';
import { Clock } from './time';
import { PhysicsWorld, RigidBody } from './physics';
import { ScriptLibrary } from './scripting';
import { Signal } from './signal';

let nextId = 1;
const EMPTY: readonly never[] = Object.freeze([]);

/**
 * A node in the scene graph: a name, a Transform (always exactly one), child objects and components.
 * `mesh`, `material`, `light`, `camera` and `rigidBody` are shortcuts for the first component of that kind.
 */
export class GameObject {
  readonly id = nextId++;
  name: string;
  readonly transform: Transform = new Transform(this);
  /** Child objects, in order. Change it through add()/remove() or transform.setParent(). */
  readonly children: readonly GameObject[] = [];

  // Cached hierarchy state, refreshed top-down whenever the parent or activeSelf changes.
  _scene: Scene | null = null;
  /** In a scene, active in the hierarchy and not destroyed: its enabled components are live. */
  _live = false;
  private _activeSelf = true;
  private _activeInHierarchy = true;
  private _destroyed = false;
  private readonly _components: Component[] = [];
  private _groups: Set<string> | null = null;
  // Kept for objects without a MeshRenderer, so the flag survives adding one later.
  private _castShadows = true;
  private _childAdded: Signal<[child: GameObject]> | null = null;
  private _childRemoved: Signal<[child: GameObject]> | null = null;
  private _destroyedSignal: Signal<[obj: GameObject]> | null = null;

  constructor(name = 'GameObject') {
    this.name = name;
  }

  // ---- hierarchy

  get parent(): GameObject | null {
    return this.transform.parent?.gameObject ?? null;
  }

  /** Adds `child` at `index` (default: last), keeping its local transform. */
  add(child: GameObject, index?: number): GameObject {
    child.transform.setParent(this.transform, false, index);
    return child;
  }

  remove(child: GameObject): void {
    if (child.parent === this) child.transform.setParent(null, false);
  }

  isAncestorOf(other: GameObject): boolean {
    return this.transform.isAncestorOf(other.transform);
  }

  /** The scene this object is in, or null when detached. */
  get scene(): Scene | null {
    return this._scene;
  }

  traverse(fn: (obj: GameObject) => void | boolean): void {
    if (fn(this) === false) return;
    for (const c of this.children) c.traverse(fn);
  }

  /** A descendant by a path of child names: `find('Body/Weapon')`. Null if any step is missing. */
  find(path: string): GameObject | null {
    let o: GameObject = this;
    for (const name of path.split('/')) {
      if (!name) continue;
      const next: GameObject | undefined = o.children.find((c) => c.name === name);
      if (!next) return null;
      o = next;
    }
    return o === this ? null : o;
  }

  /** Emitted after a child is added (including reordering under the same parent). */
  get childAdded(): Signal<[child: GameObject]> {
    return (this._childAdded ??= new Signal());
  }

  /** Emitted after a child is removed. */
  get childRemoved(): Signal<[child: GameObject]> {
    return (this._childRemoved ??= new Signal());
  }

  /** Emitted once when the object is destroyed. */
  get destroyed(): Signal<[obj: GameObject]> {
    return (this._destroyedSignal ??= new Signal());
  }

  // ---- active state

  /** The object's own active flag. Inactive objects and their descendants aren't drawn and their components don't run. */
  get activeSelf(): boolean {
    return this._activeSelf;
  }
  set activeSelf(v: boolean) {
    this.setActive(v);
  }

  setActive(active: boolean): void {
    if (active === this._activeSelf || this._destroyed) return;
    this._activeSelf = active;
    this._refreshState();
  }

  /** Active itself and all its ancestors are active. */
  get activeInHierarchy(): boolean {
    return this._activeInHierarchy;
  }

  /** Same as activeSelf (the editor's "Visible" checkbox and older scenes call it that). */
  get visible(): boolean {
    return this._activeSelf;
  }
  set visible(v: boolean) {
    this.setActive(v);
  }

  /** True when this object and all its ancestors are visible (active). */
  isVisibleInHierarchy(): boolean {
    return this._activeInHierarchy;
  }

  /** True from the moment the object is destroyed. */
  get isDestroyed(): boolean {
    return this._destroyed;
  }

  // ---- groups

  /** Groups (tags) this object belongs to. */
  get groups(): ReadonlySet<string> {
    return this._groups ?? EMPTY_SET;
  }

  addToGroup(name: string): void {
    if (this._groups?.has(name)) return;
    (this._groups ??= new Set()).add(name);
    this._scene?._groupAdd(name, this);
  }

  removeFromGroup(name: string): void {
    if (!this._groups?.delete(name)) return;
    this._scene?._groupRemove(name, this);
  }

  isInGroup(name: string): boolean {
    return this._groups?.has(name) ?? false;
  }

  // ---- components

  /** Attached components in order (not including the transform). */
  get components(): readonly Component[] {
    return this._components;
  }

  /** The attached behaviours (a new array each call). */
  get behaviours(): Behaviour[] {
    return this.getComponents(Behaviour);
  }

  /** Creates a component, applies `init` and attaches it. */
  addComponent<T extends Component>(type: ComponentType<T>, init?: ComponentInit<T>): T {
    const c = new type();
    if (init) Object.assign(c, init);
    return this.attachComponent(c);
  }

  /** Attaches an existing, detached component at `index` (default: last). */
  attachComponent<T extends Component>(component: T, index?: number): T {
    if (component.attached) throw new Error(`${component.constructor.name} is already attached to an object`);
    if (component.isDestroyed) throw new Error(`Can't attach a destroyed ${component.constructor.name}`);
    const list = this._components;
    list.splice(index === undefined ? list.length : Math.max(0, Math.min(index, list.length)), 0, component);
    component._setOwner(this);
    component._sync();
    return component;
  }

  /** Detaches a component without destroying it, so it can be attached again (the editor's undo uses this). */
  detachComponent(component: Component): boolean {
    const i = this._components.indexOf(component);
    if (i < 0) return false;
    this._components.splice(i, 1);
    component._setOwner(null);
    component._sync();
    return true;
  }

  /** Destroys a component of this object. */
  removeComponent(component: Component): void {
    if (this._components.includes(component)) GameObject.destroy(component);
  }

  /** The first component that is an instance of `type` (subclasses included), or null. */
  getComponent<T extends Component>(type: ComponentClass<T>): T | null {
    for (const c of this._components) if (c instanceof type) return c;
    return null;
  }

  /** Every component that is an instance of `type`, appended to `out`. */
  getComponents<T extends Component>(type: ComponentClass<T>, out: T[] = []): T[] {
    for (const c of this._components) if (c instanceof type) out.push(c);
    return out;
  }

  /** The first matching component on this object or a descendant (depth first), skipping inactive objects unless asked. */
  getComponentInChildren<T extends Component>(type: ComponentClass<T>, includeInactive = false): T | null {
    if (!includeInactive && !this._activeInHierarchy) return null;
    const own = this.getComponent(type);
    if (own) return own;
    for (const c of this.children) {
      const found = c.getComponentInChildren(type, includeInactive);
      if (found) return found;
    }
    return null;
  }

  /** The first matching component on this object or an ancestor. */
  getComponentInParent<T extends Component>(type: ComponentClass<T>): T | null {
    for (let o: GameObject | null = this; o; o = o.parent) {
      const c = o.getComponent(type);
      if (c) return c;
    }
    return null;
  }

  // Shortcuts for the built-in components. Setting one replaces the first component of that kind (null removes it).

  get mesh(): Mesh | null {
    return this.getComponent(MeshRenderer)?.mesh ?? null;
  }
  set mesh(m: Mesh | null) {
    this._meshRenderer(m !== null, (r) => (r.mesh = m));
  }

  get material(): Material | null {
    return this.getComponent(MeshRenderer)?.material ?? null;
  }
  set material(m: Material | null) {
    this._meshRenderer(m !== null, (r) => (r.material = m));
  }

  get castShadows(): boolean {
    return this.getComponent(MeshRenderer)?.castShadows ?? this._castShadows;
  }
  set castShadows(v: boolean) {
    this._castShadows = v;
    const r = this.getComponent(MeshRenderer);
    if (r) r.castShadows = v;
  }

  get light(): Light | null {
    return this.getComponent(Light);
  }
  set light(l: Light | null) {
    this._replace(Light, l);
  }

  get camera(): CameraComponent | null {
    return this.getComponent(CameraComponent);
  }
  set camera(c: CameraComponent | null) {
    this._replace(CameraComponent, c);
  }

  get rigidBody(): RigidBody | null {
    return this.getComponent(RigidBody);
  }
  set rigidBody(rb: RigidBody | null) {
    this._replace(RigidBody, rb);
  }

  private _meshRenderer(create: boolean, edit: (r: MeshRenderer) => void): void {
    let r = this.getComponent(MeshRenderer);
    if (!r) {
      if (!create) return;
      r = this.addComponent(MeshRenderer, { castShadows: this._castShadows });
    }
    edit(r);
    // A renderer with nothing to draw is only noise in the registry.
    if (!r.mesh && !r.material) this.detachComponent(r);
  }

  private _replace<T extends Component>(type: ComponentClass<T>, next: T | null): void {
    const old = this.getComponent(type);
    if (old === next) return;
    const index = old ? this._components.indexOf(old) : undefined;
    if (old) this.detachComponent(old);
    if (next) this.attachComponent(next, index);
  }

  // ---- world-space shortcuts (see Transform)

  /** World matrix (cached and always current; don't modify). */
  get worldMatrix(): Mat4 {
    return this.transform.worldMatrix;
  }

  get normalMatrix(): Mat4 {
    return this.transform.normalMatrix;
  }

  /** A copy of the world matrix. */
  computeWorldMatrix(): Mat4 {
    return mat4.clone(this.transform.worldMatrix);
  }

  worldPosition(): Vec3 {
    return this.transform.worldPosition;
  }

  worldRotation(): Quat {
    return this.transform.worldRotation;
  }

  /** Direction the object faces (local -Z) in world space. */
  forward(): Vec3 {
    return this.transform.forward;
  }

  /** Sets the world-space position, converting into the parent's space. */
  setWorldPosition(p: Vec3): void {
    this.transform.worldPosition = p;
  }

  setWorldRotation(q: Quat): void {
    this.transform.worldRotation = q;
  }

  /** Re-parents while keeping the current world transform. */
  setParentKeepWorld(parent: GameObject, index?: number): void {
    this.transform.setParent(parent.transform, true, index);
  }

  // ---- copies and destruction

  /**
   * Deep copy of the object, its components (via Component.clone()) and descendants. Meshes and textures are shared;
   * materials are copied. The copy is detached; see GameObject.instantiate().
   */
  clone(): GameObject {
    const o = new GameObject(this.name);
    o.transform.copyFrom(this.transform);
    o._activeSelf = this._activeSelf;
    o._castShadows = this._castShadows;
    for (const c of this._components) o.attachComponent(c.clone());
    if (this._groups) for (const g of this._groups) o.addToGroup(g);
    for (const c of this.children) o.add(c.clone());
    return o;
  }

  /**
   * Clones `original` into a scene: under `parent` (keeping the original's local transform) or, by default, at the
   * top level of the original's scene where the original is in the world.
   */
  static instantiate(original: GameObject, parent?: GameObject): GameObject {
    const copy = original.clone();
    if (parent) {
      parent.add(copy);
    } else if (original._scene) {
      const at = original.parent ?? original._scene.root;
      at.add(copy);
      copy.transform.setParent(original._scene.root.transform, true);
    }
    return copy;
  }

  /**
   * Destroys an object (with its descendants) or a single component. In a running scene this is deferred: the target
   * is marked at once (it leaves Scene.query() and gets no further callbacks), and onDisable → onDestroy run and it is
   * detached at the end of the frame (Scene.processDestroyed). Elsewhere it happens immediately.
   */
  static destroy(target: GameObject | Component): void {
    if (target.isDestroyed) return;
    const obj = target instanceof Component ? (target.attached ? target.gameObject : null) : target;
    if (target instanceof Component) {
      target._destroyed = true;
      target._sync();
    } else {
      target._markDestroyed();
    }
    const scene = obj?._scene;
    if (scene?.running) scene._queueDestroy(target);
    else GameObject._finishDestroy(target);
  }

  /** Runs the destroy callbacks and detaches `target`. Called by destroy() or at the end of the frame. */
  static _finishDestroy(target: GameObject | Component): void {
    if (target instanceof Component) {
      if (target instanceof Behaviour) teardown(target);
      if (target.attached) target.gameObject.detachComponent(target);
      target._disposed();
      Signal.disconnectOwner(target);
      return;
    }
    const behaviours: Behaviour[] = [];
    target.traverse((o) => void o.getComponents(Behaviour, behaviours));
    for (const b of behaviours) if (b._enabledCalled) disable(b);
    for (const b of behaviours) if (b._awoken) destroyHook(b);
    target.parent?.remove(target);
    target._dispose();
  }

  // Sets the destroyed flags for the whole subtree first, so the following sync sees every component as destroyed.
  private _markDestroyed(): void {
    this.traverse((o) => {
      o._destroyed = true;
      for (const c of o._components) c._destroyed = true;
    });
    this._refreshState();
    this.traverse((o) => {
      for (const c of o._components) c._sync();
    });
  }

  private _dispose(): void {
    for (const c of this.children) c._dispose();
    for (const c of this._components) {
      c._disposed();
      Signal.disconnectOwner(c);
    }
    this._destroyedSignal?.emit(this);
    this._destroyedSignal?.disconnectAll();
    Signal.disconnectOwner(this);
  }

  // ---- internal state upkeep

  /** Called by Transform.setParent after the hierarchy changed. */
  _parentChanged(oldParent: GameObject | null): void {
    this._refreshState();
    const parent = this.parent;
    if (oldParent && oldParent !== parent) oldParent._childRemoved?.emit(this);
    if (parent) parent._childAdded?.emit(this);
  }

  /** Marks this object as the root of `scene`. */
  _makeSceneRoot(scene: Scene): void {
    this._scene = scene;
    this._refreshState();
  }

  /** Recomputes scene, activeInHierarchy and liveness for this subtree and syncs components whose state changed. */
  private _refreshState(): void {
    const parent = this.parent;
    const scene = parent ? parent._scene : this._scene?.root === this ? this._scene : null;
    const active = this._activeSelf && (parent ? parent._activeInHierarchy : true);
    const live = scene !== null && active && !this._destroyed;
    const sceneChanged = scene !== this._scene;
    if (!sceneChanged && active === this._activeInHierarchy && live === this._live) return;
    if (sceneChanged && this._groups) {
      for (const g of this._groups) this._scene?._groupRemove(g, this);
      for (const g of this._groups) scene?._groupAdd(g, this);
    }
    this._scene = scene;
    this._activeInHierarchy = active;
    this._live = live;
    for (const c of this._components) c._sync();
    for (const c of this.children) c._refreshState();
  }
}

const EMPTY_SET: ReadonlySet<string> = new Set();

export class Scene {
  /** Invisible container; top-level objects are its children. */
  readonly root = new GameObject('Scene');
  /** Linear RGB ambient light color, multiplied by ambientIntensity. */
  ambientColor: Vec3 = [0.55, 0.62, 0.75];
  ambientIntensity = 0.25;
  /** Clear color (display space). */
  background: Vec3 = [0.06, 0.062, 0.065];
  exposure = 1;
  /** Half extent (world units) of the directional shadow frustum. */
  shadowExtent = 16;
  readonly physics = new PhysicsWorld();
  /** TypeScript behaviour scripts available to this scene's objects. */
  readonly scripts = new ScriptLibrary();

  /** Emitted when a behaviour's hook throws (the behaviour is then paused). Without listeners the error is logged. */
  readonly behaviourError = new Signal<[behaviour: Behaviour, error: unknown, hook: string]>();

  // Live components by class, for every class in each component's prototype chain below Component.
  private readonly _registry = new Map<ComponentClass<Component>, Component[]>();
  private readonly _groups = new Map<string, GameObject[]>();

  // Behaviour lifecycle while running. Dispatch lists only hold started, enabled behaviours whose class overrides
  // the hook; removals during a dispatch leave a null that is compacted afterwards.
  private _running = false;
  private readonly _startQueue: Behaviour[] = [];
  private readonly _updateList: (Behaviour | null)[] = [];
  private readonly _fixedList: (Behaviour | null)[] = [];
  private readonly _lateList: (Behaviour | null)[] = [];
  private _dispatching = 0;
  private _holes = false;
  private readonly _destroyQueue: (GameObject | Component)[] = [];
  // Fixed-step clock for the update() convenience; the engine drives the phases with Time instead.
  private readonly _clock = new Clock();

  constructor() {
    this.root._makeSceneRoot(this);
  }

  /** The top-level objects. */
  get rootObjects(): readonly GameObject[] {
    return this.root.children;
  }

  add(obj: GameObject, parent: GameObject = this.root): GameObject {
    return parent.add(obj);
  }

  remove(obj: GameObject): void {
    obj.parent?.remove(obj);
  }

  traverse(fn: (obj: GameObject) => void | boolean): void {
    for (const c of this.root.children) c.traverse(fn);
  }

  find(predicate: (obj: GameObject) => boolean): GameObject | null {
    let found: GameObject | null = null;
    this.traverse((o) => {
      if (found) return false;
      if (predicate(o)) found = o;
    });
    return found;
  }

  findByName(name: string): GameObject | null {
    return this.find((o) => o.name === name);
  }

  /**
   * Live components of a class (subclasses included): enabled, on objects active in this scene. The array is kept up
   * to date as components are added, removed, enabled and disabled, so don't modify it, and copy it if you change
   * the scene while iterating.
   */
  query<T extends Component>(type: ComponentClass<T>): readonly T[] {
    return (this._registry.get(type) as T[] | undefined) ?? EMPTY;
  }

  /** Objects in this scene that are in group `name` (active or not), in the order they joined. */
  getGroup(name: string): readonly GameObject[] {
    return this._groups.get(name) ?? EMPTY;
  }

  /** The camera the game renders through: the live camera with the highest priority (ties: the one listed first). */
  activeCamera(): GameObject | null {
    let best: CameraComponent | null = null;
    for (const c of this.query(CameraComponent)) if (!best || c.priority > best.priority) best = c;
    return best?.gameObject ?? null;
  }

  /** Brings every world matrix up to date in one top-down pass (world matrices are also correct when read lazily). */
  updateMatrices(): void {
    updateSubtree(this.root);
  }

  // ---- behaviour lifecycle

  /** Whether behaviours run (Play). */
  get running(): boolean {
    return this._running;
  }

  /**
   * Starts or stops running behaviours. Starting wakes every live behaviour (awake, then onEnable; start comes before
   * its first update). Stopping runs onDisable and onDestroy and forgets lifecycle state, so the next start begins
   * with awake again.
   */
  setRunning(running: boolean): void {
    if (running === this._running) return;
    const all: Behaviour[] = [];
    this.root.traverse((o) => void o.getComponents(Behaviour, all));
    if (running) {
      this._running = true;
      this._clock.reset();
      for (const b of all) b._sync();
      return;
    }
    this.processDestroyed();
    for (const b of all) if (b._enabledCalled) disable(b);
    for (const b of all) if (b._awoken) destroyHook(b);
    this._running = false;
    for (const b of all) b._resetLifecycle();
    this._startQueue.length = this._updateList.length = this._fixedList.length = this._lateList.length = 0;
  }

  /** One fixed step: start pending behaviours, fixedUpdate, then physics. */
  fixedUpdate(fixedDt: number): void {
    if (!this._running) return;
    this._flushStarts();
    this._dispatch(this._fixedList, HOOK_FIXED_UPDATE, fixedDt, 0);
    this.physics.step(this, fixedDt);
  }

  /** Starts pending behaviours, then runs update(dt, time). */
  updateBehaviours(dt: number, time: number): void {
    if (!this._running) return;
    this._flushStarts();
    this._dispatch(this._updateList, HOOK_UPDATE, dt, time);
  }

  lateUpdate(dt: number): void {
    if (!this._running) return;
    this._dispatch(this._lateList, HOOK_LATE_UPDATE, dt, 0);
  }

  /** Finishes destroys requested during the frame (onDisable → onDestroy → detach). The engine calls it last. */
  processDestroyed(): void {
    const q = this._destroyQueue;
    for (let i = 0; i < q.length; i++) GameObject._finishDestroy(q[i]);
    q.length = 0;
  }

  /**
   * Runs one whole frame with the scene's own fixed-step clock: when playing, fixed steps, update and lateUpdate;
   * then world matrices and pending destroys. Handy for tools and tests; the engine drives the phases itself.
   */
  update(dt: number, time: number, playing: boolean): void {
    if (playing) {
      this.setRunning(true);
      const steps = this._clock.beginFrame(dt);
      for (let i = 0; i < steps; i++) {
        this.fixedUpdate(this._clock.fixedDeltaTime);
        this._clock.fixedStepDone();
      }
      this.updateBehaviours(dt, time);
      this.lateUpdate(dt);
    }
    this.updateMatrices();
    this.processDestroyed();
  }

  _queueStart(b: Behaviour): void {
    if (b._startQueued) return;
    b._startQueued = true;
    this._startQueue.push(b);
  }

  _queueDestroy(target: GameObject | Component): void {
    this._destroyQueue.push(target);
  }

  _addToLists(b: Behaviour): void {
    if (b._inLists) return;
    b._inLists = true;
    const hooks = b._hooks();
    if (hooks & HOOK_UPDATE) this._updateList.push(b);
    if (hooks & HOOK_FIXED_UPDATE) this._fixedList.push(b);
    if (hooks & HOOK_LATE_UPDATE) this._lateList.push(b);
  }

  _removeFromLists(b: Behaviour): void {
    if (!b._inLists) return;
    b._inLists = false;
    this._removeFrom(this._updateList, b);
    this._removeFrom(this._fixedList, b);
    this._removeFrom(this._lateList, b);
  }

  private _removeFrom(list: (Behaviour | null)[], b: Behaviour): void {
    const i = list.indexOf(b);
    if (i < 0) return;
    if (this._dispatching > 0) {
      list[i] = null;
      this._holes = true;
    } else {
      list.splice(i, 1);
    }
  }

  // Behaviours queued while starting others start in the same flush (before anyone's first update).
  private _flushStarts(): void {
    const q = this._startQueue;
    for (let i = 0; i < q.length; i++) {
      const b = q[i];
      b._startQueued = false;
      if (!b._enabledCalled || b._started || b._destroyed || b._lifeScene !== this) continue;
      b._started = true;
      b._invoke('start');
      if (b._started && b._enabledCalled && !b._destroyed && b._lifeScene === this) this._addToLists(b);
    }
    q.length = 0;
  }

  // Behaviours added during a dispatch first run in the next one (the loop stops at the length it started with).
  private _dispatch(list: (Behaviour | null)[], hook: number, a: number, b: number): void {
    this._dispatching++;
    const end = list.length;
    try {
      for (let i = 0; i < end; i++) {
        const beh = list[i];
        if (beh === null || beh._failed) continue;
        try {
          if (hook === HOOK_UPDATE) beh.update(a, b);
          else if (hook === HOOK_FIXED_UPDATE) beh.fixedUpdate(a);
          else beh.lateUpdate(a);
        } catch (err) {
          beh._fail(err, hook === HOOK_UPDATE ? 'update' : hook === HOOK_FIXED_UPDATE ? 'fixedUpdate' : 'lateUpdate');
        }
      }
    } finally {
      if (--this._dispatching === 0 && this._holes) this._compact();
    }
  }

  private _compact(): void {
    this._holes = false;
    for (const list of [this._updateList, this._fixedList, this._lateList]) {
      let j = 0;
      for (let i = 0; i < list.length; i++) if (list[i] !== null) list[j++] = list[i];
      list.length = j;
    }
  }

  _register(c: Component): void {
    for (let proto = Object.getPrototypeOf(c); proto && proto !== Component.prototype; proto = Object.getPrototypeOf(proto)) {
      const type = proto.constructor as ComponentClass<Component>;
      let list = this._registry.get(type);
      if (!list) this._registry.set(type, (list = []));
      list.push(c);
    }
  }

  _unregister(c: Component): void {
    for (let proto = Object.getPrototypeOf(c); proto && proto !== Component.prototype; proto = Object.getPrototypeOf(proto)) {
      const list = this._registry.get(proto.constructor as ComponentClass<Component>);
      const i = list ? list.indexOf(c) : -1;
      if (i >= 0) list!.splice(i, 1);
    }
  }

  _groupAdd(name: string, obj: GameObject): void {
    let list = this._groups.get(name);
    if (!list) this._groups.set(name, (list = []));
    list.push(obj);
  }

  _groupRemove(name: string, obj: GameObject): void {
    const list = this._groups.get(name);
    const i = list ? list.indexOf(obj) : -1;
    if (i >= 0) list!.splice(i, 1);
  }
}

function disable(b: Behaviour): void {
  b._enabledCalled = false;
  b._lifeScene?._removeFromLists(b);
  b._invoke('onDisable');
}

function destroyHook(b: Behaviour): void {
  b._awoken = false;
  b._invoke('onDestroy');
}

function teardown(b: Behaviour): void {
  if (b._enabledCalled) disable(b);
  if (b._awoken) destroyHook(b);
}

function updateSubtree(obj: GameObject): void {
  obj.transform.updateWorld();
  for (const c of obj.children) updateSubtree(c);
}
