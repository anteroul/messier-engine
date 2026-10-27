import { mat4, type Mat4, type Quat, type Vec3 } from './math';
import { Transform } from './transform';
import { Component, type ComponentClass, type ComponentInit, type ComponentType } from './component';
import { MeshRenderer } from './meshRenderer';
import type { Mesh } from './mesh';
import type { Material } from './material';
import { Light } from './light';
import { CameraComponent } from './camera';
import type { Behaviour } from './behaviours';
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
  behaviours: Behaviour[] = [];

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
    o.behaviours = this.behaviours.map((b) => b.clone());
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

  /** Destroys an object (with its descendants) or a single component. */
  static destroy(target: GameObject | Component): void {
    if (target instanceof Component) {
      if (target.isDestroyed) return;
      target._destroyed = true;
      target._sync();
      if (target.attached) target.gameObject.detachComponent(target);
      Signal.disconnectOwner(target);
      return;
    }
    if (target._destroyed) return;
    target.parent?.remove(target);
    target._markDestroyed();
  }

  private _markDestroyed(): void {
    this._destroyed = true;
    for (const c of this.children) c._markDestroyed();
    for (const c of this._components) {
      c._destroyed = true;
      c._sync();
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

  // Live components by class, for every class in each component's prototype chain below Component.
  private readonly _registry = new Map<ComponentClass<Component>, Component[]>();
  private readonly _groups = new Map<string, GameObject[]>();

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

  /** Runs behaviours and physics (when playing) and refreshes world matrices. */
  update(dt: number, time: number, playing: boolean): void {
    if (playing) {
      this.traverse((o) => {
        if (!o.activeInHierarchy) return false;
        for (const b of o.behaviours) if (b.enabled) b.update(o, dt, time);
      });
      this.physics.update(this, dt);
    }
    this.updateMatrices();
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

function updateSubtree(obj: GameObject): void {
  obj.transform.updateWorld();
  for (const c of obj.children) updateSubtree(c);
}
