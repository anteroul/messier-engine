import { hsvToRgb, quat, vec3, type Vec3 } from './math';
import { Component } from './component';
import type { Scene } from './scene';

type Hook = 'awake' | 'onEnable' | 'start' | 'update' | 'fixedUpdate' | 'lateUpdate' | 'onDisable' | 'onDestroy';

/** Bit per dispatched hook, for the per-class "which hooks are overridden" cache. */
export const HOOK_UPDATE = 1;
export const HOOK_FIXED_UPDATE = 2;
export const HOOK_LATE_UPDATE = 4;
const overriddenHooks = new WeakMap<object, number>();

/**
 * Scripting component. Override the lifecycle hooks you need:
 *
 * - `awake()` once, when the object is first active in a running scene (even if the behaviour is disabled)
 * - `onEnable()` / `onDisable()` whenever the behaviour becomes live / stops being live (enabled, object active)
 * - `start()` once, right before the first update or fixedUpdate, only while enabled
 * - `fixedUpdate(fixedDt)` on every fixed step, `update(dt, time)` and `lateUpdate(dt)` every frame
 * - `onDestroy()` once, when the behaviour or its object is destroyed (or the scene stops running)
 *
 * Hooks only run while the scene is running (Play). A behaviour is only dispatched for the per-frame hooks its class
 * actually overrides, so an empty update costs nothing. Public number fields are the parameters the editor shows.
 */
export abstract class Behaviour extends Component {
  awake(): void {}
  onEnable(): void {}
  start(): void {}
  /** `time` is seconds since the scene started running (the same as Time.time when the engine drives it). */
  update(_dt: number, _time: number): void {}
  fixedUpdate(_fixedDt: number): void {}
  lateUpdate(_dt: number): void {}
  onDisable(): void {}
  onDestroy(): void {}

  // Lifecycle state, managed by _sync() and the scene's dispatch.
  _awoken = false;
  _enabledCalled = false;
  _started = false;
  _startQueued = false;
  _inLists = false;
  /** Threw from a hook: skipped by update/fixedUpdate/lateUpdate until the scene restarts (or a script recompiles). */
  _failed = false;
  /** The running scene whose dispatch lists this behaviour is in (or is queued to start in). */
  _lifeScene: Scene | null = null;
  private _paramsView: Record<string, number> | null = null;

  /** Name used in the editor and in saved scenes. */
  get typeName(): string {
    return (this.constructor as { typeName?: string }).typeName ?? this.constructor.name;
  }

  /** True after a hook threw; the behaviour is paused until the scene restarts. */
  get failed(): boolean {
    return this._failed;
  }

  /** Names of the inspector-editable number fields: own public number fields (not starting with `_`). */
  paramNames(): string[] {
    const src = this as unknown as Record<string, unknown>;
    return Object.keys(this).filter((k) => !k.startsWith('_') && typeof src[k] === 'number');
  }

  getParam(name: string): number | undefined {
    const v = (this as unknown as Record<string, unknown>)[name];
    return typeof v === 'number' ? v : undefined;
  }

  setParam(name: string, value: number): void {
    (this as unknown as Record<string, unknown>)[name] = value;
  }

  /** The parameters as a plain-looking record (reads and writes go through getParam/setParam). */
  get params(): Record<string, number> {
    return (this._paramsView ??= new Proxy({} as Record<string, number>, {
      get: (_t, k) => (typeof k === 'string' && this.paramNames().includes(k) ? this.getParam(k) : undefined),
      set: (_t, k, v) => {
        if (typeof k !== 'string' || typeof v !== 'number') return false;
        this.setParam(k, v);
        return true;
      },
      has: (_t, k) => typeof k === 'string' && this.paramNames().includes(k),
      ownKeys: () => this.paramNames(),
      getOwnPropertyDescriptor: (_t, k) =>
        typeof k === 'string' && this.paramNames().includes(k) ? { value: this.getParam(k), writable: true, enumerable: true, configurable: true } : undefined,
    }));
  }

  /** Which of update/fixedUpdate/lateUpdate this behaviour's class overrides (HOOK_* bits). */
  _hooks(): number {
    const proto = Object.getPrototypeOf(this) as object;
    let bits = overriddenHooks.get(proto);
    if (bits === undefined) {
      const base = Behaviour.prototype;
      const self = this as Behaviour;
      bits =
        (self.update !== base.update ? HOOK_UPDATE : 0) |
        (self.fixedUpdate !== base.fixedUpdate ? HOOK_FIXED_UPDATE : 0) |
        (self.lateUpdate !== base.lateUpdate ? HOOK_LATE_UPDATE : 0);
      overriddenHooks.set(proto, bits);
    }
    return bits;
  }

  _sync(): void {
    super._sync();
    if (this._destroyed) {
      // Destroyed mid-frame: no more callbacks until the scene runs onDisable/onDestroy at the end of the frame.
      this._lifeScene?._removeFromLists(this);
      return;
    }
    const obj = this.attached ? this.gameObject : null;
    const scene = obj && obj._live ? obj._scene : null;
    const running = scene !== null && scene.running;
    if (running && !this._awoken) {
      this._awoken = true;
      this._lifeScene = scene;
      this._invoke('awake');
      // awake() may have disabled, deactivated or destroyed things; start over with fresh state.
      this._sync();
      return;
    }
    const shouldEnable = running && this.enabled;
    // Moved between running scenes: leave the old one's lists first.
    if (this._enabledCalled && (!shouldEnable || this._lifeScene !== scene)) {
      this._enabledCalled = false;
      this._lifeScene?._removeFromLists(this);
      this._invoke('onDisable');
      if (shouldEnable) this._sync();
      return;
    }
    if (shouldEnable && !this._enabledCalled) {
      this._enabledCalled = true;
      this._lifeScene = scene;
      this._invoke('onEnable');
      if (!this._enabledCalled || this._lifeScene !== scene) return; // changed inside onEnable
      if (this._started) scene._addToLists(this);
      else scene._queueStart(this);
    }
  }

  /** Calls a hook, turning an exception into a failure report instead of breaking the frame. */
  _invoke(hook: Hook): void {
    try {
      (this[hook] as () => void)();
    } catch (err) {
      this._fail(err, hook);
    }
  }

  _fail(err: unknown, hook: Hook): void {
    this._failed = true;
    const scene = this._lifeScene ?? (this.attached ? this.gameObject.scene : null);
    if (scene && scene.behaviourError.connectionCount > 0) scene.behaviourError.emit(this, err, hook);
    else console.error(`${this.typeName}.${hook}() threw:`, err);
  }

  /** Forgets lifecycle state so the next run starts with awake() again. */
  _resetLifecycle(): void {
    this._awoken = this._enabledCalled = this._started = this._startQueued = this._inLists = this._failed = false;
    this._lifeScene = null;
  }
}

/** Spins the object; speeds in degrees per second around each local axis. */
export class Rotator extends Behaviour {
  static readonly typeName = 'Rotator';
  speedX = 0;
  speedY = 45;
  speedZ = 0;
  constructor(init: Partial<Pick<Rotator, 'speedX' | 'speedY' | 'speedZ'>> = {}) {
    super();
    Object.assign(this, init);
  }
  update(dt: number): void {
    const t = this.transform;
    const delta = quat.fromEulerDeg(this.speedX * dt, this.speedY * dt, this.speedZ * dt);
    t.rotation = quat.normalize(quat.multiply(t.rotation, delta));
  }
}

/** Moves the object up and down around its start position. */
export class Bobber extends Behaviour {
  static readonly typeName = 'Bobber';
  amplitude = 0.5;
  frequency = 0.5;
  private _baseY = 0;
  constructor(init: Partial<Pick<Bobber, 'amplitude' | 'frequency'>> = {}) {
    super();
    Object.assign(this, init);
  }
  start(): void {
    this._baseY = this.transform.position[1];
  }
  update(_dt: number, time: number): void {
    this.transform.position[1] = this._baseY + Math.sin(time * this.frequency * Math.PI * 2) * this.amplitude;
  }
}

/** Circles around the position the object had when Play started. */
export class Orbiter extends Behaviour {
  static readonly typeName = 'Orbiter';
  radius = 3;
  speed = 0.5;
  phase = 0;
  private _center: Vec3 = [0, 0, 0];
  constructor(init: Partial<Pick<Orbiter, 'radius' | 'speed' | 'phase'>> = {}) {
    super();
    Object.assign(this, init);
  }
  start(): void {
    this._center = vec3.clone(this.transform.position);
  }
  update(_dt: number, time: number): void {
    const a = time * this.speed + this.phase;
    const c = this._center;
    this.transform.position = [c[0] + Math.cos(a) * this.radius, c[1], c[2] + Math.sin(a) * this.radius];
  }
}

/** Light only: modulates intensity like a flame or a pulsing beacon. */
export class LightPulse extends Behaviour {
  static readonly typeName = 'LightPulse';
  amount = 0.5;
  frequency = 1;
  flicker = 0;
  private _base = 1;
  constructor(init: Partial<Pick<LightPulse, 'amount' | 'frequency' | 'flicker'>> = {}) {
    super();
    Object.assign(this, init);
  }
  start(): void {
    this._base = this.gameObject.light?.intensity ?? 1;
  }
  update(_dt: number, time: number): void {
    const light = this.gameObject.light;
    if (!light) return;
    const wave = Math.sin(time * this.frequency * Math.PI * 2);
    const noise = this.flicker > 0 ? (Math.random() * 2 - 1) * this.flicker : 0;
    light.intensity = Math.max(0, this._base * (1 + wave * this.amount + noise));
  }
}

/** Light only: cycles the light hue. */
export class ColorCycle extends Behaviour {
  static readonly typeName = 'ColorCycle';
  speed = 0.1;
  saturation = 0.8;
  offset = 0;
  constructor(init: Partial<Pick<ColorCycle, 'speed' | 'saturation' | 'offset'>> = {}) {
    super();
    Object.assign(this, init);
  }
  update(_dt: number, time: number): void {
    const light = this.gameObject.light;
    if (!light) return;
    const h = (time * this.speed + this.offset) % 1;
    light.color = hsvToRgb(h, this.saturation, 1);
  }
}

/** Built-in behaviours by typeName (the editor's Add menu and scene loading). */
export const BEHAVIOURS: Record<string, () => Behaviour> = {
  Rotator: () => new Rotator(),
  Bobber: () => new Bobber(),
  Orbiter: () => new Orbiter(),
  LightPulse: () => new LightPulse(),
  ColorCycle: () => new ColorCycle(),
};

export function createBehaviour(type: string): Behaviour {
  const factory = BEHAVIOURS[type];
  if (!factory) throw new Error(`Unknown behaviour "${type}"`);
  return factory();
}
