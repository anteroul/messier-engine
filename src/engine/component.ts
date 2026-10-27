import type { GameObject, Scene } from './scene';
import type { Transform } from './transform';

/** A concrete component class that addComponent() can construct. */
export type ComponentType<T extends Component> = new () => T;
/** Any component class, including abstract ones like Behaviour, for lookups and queries. */
export type ComponentClass<T extends Component> = abstract new (...args: never[]) => T;

type DataKeys<T> = { [K in keyof T]: T[K] extends (...args: never[]) => unknown ? never : K }[keyof T];
/** Initial field values for addComponent(), applied before the component is attached (so before awake). */
export type ComponentInit<T> = Partial<Pick<T, DataKeys<T>>>;

/**
 * Base class of everything attached to a GameObject (except its Transform). A component is *live* while it's
 * enabled and its object is active in the hierarchy of a scene; live components are listed by Scene.query().
 */
export abstract class Component {
  private _gameObject: GameObject | null = null;
  private _enabled = true;
  // Registry state, owned by the scene: the scene this component is listed in, or null.
  _registeredIn: Scene | null = null;
  _destroyed = false;

  /** The object this component is attached to. Throws before it's attached (e.g. in field initializers). */
  get gameObject(): GameObject {
    const o = this._gameObject;
    if (!o) throw new Error(`${this.constructor.name} is not attached to a GameObject yet (use it from awake() or start() on)`);
    return o;
  }

  /** Whether the component is attached to an object. */
  get attached(): boolean {
    return this._gameObject !== null;
  }

  get transform(): Transform {
    return this.gameObject.transform;
  }

  get enabled(): boolean {
    return this._enabled;
  }
  set enabled(v: boolean) {
    if (v === this._enabled) return;
    this._enabled = v;
    this._sync();
  }

  /** Enabled, attached to an object that is active in a scene's hierarchy, and not destroyed. */
  get isActiveAndEnabled(): boolean {
    return this._registeredIn !== null;
  }

  /** True from the moment the component (or its object) is destroyed. */
  get isDestroyed(): boolean {
    return this._destroyed;
  }

  /**
   * A detached copy for GameObject.clone()/instantiate(). The default constructs the same class and copies own
   * enumerable fields that don't start with `_`, copying arrays and typed arrays one level deep (vectors) and
   * sharing other objects. Override it when a component holds state that needs deeper copies.
   */
  clone(): Component {
    const c = new (this.constructor as new () => Component)();
    const src = this as unknown as Record<string, unknown>;
    const dst = c as unknown as Record<string, unknown>;
    for (const key of Object.keys(this)) {
      if (key.startsWith('_')) continue;
      const v = src[key];
      dst[key] = Array.isArray(v) ? v.slice() : ArrayBuffer.isView(v) && !(v instanceof DataView) ? (v as Float32Array).slice() : v;
    }
    c._enabled = this._enabled;
    return c;
  }

  /** Public fields only, so components can be logged and stringified (the owner link would be circular). */
  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const src = this as unknown as Record<string, unknown>;
    for (const key of Object.keys(this)) if (!key.startsWith('_')) out[key] = src[key];
    return out;
  }

  /** Called once when the destruction completes (after onDestroy for behaviours). */
  _disposed(): void {}

  /** Called by GameObject when this component is attached to or detached from it. */
  _setOwner(obj: GameObject | null): void {
    this._gameObject = obj;
  }

  /**
   * Re-evaluates whether the component should be listed in its scene (and, for behaviours, which lifecycle callbacks
   * are due). Called whenever enabled, the object's active state, its scene or the destroyed flag may have changed.
   */
  _sync(): void {
    const obj = this._gameObject;
    const scene = obj && !this._destroyed && this._enabled && obj._live ? obj._scene : null;
    if (scene === this._registeredIn) return;
    this._registeredIn?._unregister(this);
    this._registeredIn = scene;
    scene?._register(this);
  }
}
