import { hsvToRgb, quat, vec3, type Vec3 } from './math';
import type { GameObject } from './scene';

/**
 * Script component. Behaviours only run while the editor is in Play mode.
 * `params` are plain numbers so the inspector can edit any behaviour generically.
 */
export abstract class Behaviour {
  abstract readonly type: string;
  enabled = true;
  params: Record<string, number>;

  constructor(params: Record<string, number>) {
    this.params = { ...params };
  }

  /** Called when Play mode starts, before the first update. */
  start(_obj: GameObject): void {}

  abstract update(obj: GameObject, dt: number, time: number): void;

  clone(): Behaviour {
    const b = createBehaviour(this.type);
    b.params = { ...this.params };
    b.enabled = this.enabled;
    return b;
  }
}

/** Spins the object; speeds in degrees per second around each local axis. */
export class Rotator extends Behaviour {
  readonly type = 'Rotator';
  constructor(params: Partial<Record<'speedX' | 'speedY' | 'speedZ', number>> = {}) {
    super({ speedX: 0, speedY: 45, speedZ: 0, ...params });
  }
  update(obj: GameObject, dt: number): void {
    const p = this.params;
    const delta = quat.fromEulerDeg(p.speedX * dt, p.speedY * dt, p.speedZ * dt);
    obj.transform.rotation = quat.normalize(quat.multiply(obj.transform.rotation, delta));
  }
}

/** Moves the object up and down around its start position. */
export class Bobber extends Behaviour {
  readonly type = 'Bobber';
  private baseY = 0;
  constructor(params: Partial<Record<'amplitude' | 'frequency', number>> = {}) {
    super({ amplitude: 0.5, frequency: 0.5, ...params });
  }
  start(obj: GameObject): void {
    this.baseY = obj.transform.position[1];
  }
  update(obj: GameObject, _dt: number, time: number): void {
    obj.transform.position[1] = this.baseY + Math.sin(time * this.params.frequency * Math.PI * 2) * this.params.amplitude;
  }
}

/** Circles around the position the object had when Play started. */
export class Orbiter extends Behaviour {
  readonly type = 'Orbiter';
  private center: Vec3 = [0, 0, 0];
  constructor(params: Partial<Record<'radius' | 'speed' | 'phase', number>> = {}) {
    super({ radius: 3, speed: 0.5, phase: 0, ...params });
  }
  start(obj: GameObject): void {
    this.center = vec3.clone(obj.transform.position);
  }
  update(obj: GameObject, _dt: number, time: number): void {
    const a = time * this.params.speed + this.params.phase;
    const r = this.params.radius;
    obj.transform.position = [this.center[0] + Math.cos(a) * r, this.center[1], this.center[2] + Math.sin(a) * r];
  }
}

/** Light only: modulates intensity like a flame or a pulsing beacon. */
export class LightPulse extends Behaviour {
  readonly type = 'LightPulse';
  private base = 1;
  constructor(params: Partial<Record<'amount' | 'frequency' | 'flicker', number>> = {}) {
    super({ amount: 0.5, frequency: 1, flicker: 0, ...params });
  }
  start(obj: GameObject): void {
    this.base = obj.light?.intensity ?? 1;
  }
  update(obj: GameObject, _dt: number, time: number): void {
    if (!obj.light) return;
    const p = this.params;
    const wave = Math.sin(time * p.frequency * Math.PI * 2);
    const noise = p.flicker > 0 ? (Math.random() * 2 - 1) * p.flicker : 0;
    obj.light.intensity = Math.max(0, this.base * (1 + wave * p.amount + noise));
  }
}

/** Light only: cycles the light hue. */
export class ColorCycle extends Behaviour {
  readonly type = 'ColorCycle';
  constructor(params: Partial<Record<'speed' | 'saturation' | 'offset', number>> = {}) {
    super({ speed: 0.1, saturation: 0.8, offset: 0, ...params });
  }
  update(obj: GameObject, _dt: number, time: number): void {
    if (!obj.light) return;
    const h = (time * this.params.speed + this.params.offset) % 1;
    obj.light.color = hsvToRgb(h, this.params.saturation, 1);
  }
}

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
