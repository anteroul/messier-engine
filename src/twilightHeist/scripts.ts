import type { ScriptList } from '../demos/shared';

// Twilight Heist's scripts (source strings, as they'd be written in the Scripts tab). tsc never sees them:
// tests/unit/twilight-heist.test.ts plays the game, which is what catches typos.

const HEIST_SCRIPT = `import { AudioSource, Script, Shape2D, Text2D, clamp, input, quat, raycastScene, vec3, worldBounds, type GameObject, type Light, type Vec3 } from 'messier';

interface Box {
  min: Vec3;
  max: Vec3;
}

interface Lamp {
  object: GameObject;
  light: Light;
}

/**
 * The heist: sneak the thief around the garden (WASD / arrows), take every coin, and leave through the gate. The
 * watchtower lamps see you wherever their light reaches you: in a shadow, behind a hedge or a statue, you're hidden.
 * A lamp that sees you fills the alarm; a full alarm sends you back to the start.
 */
export default class Heist extends Script {
  /** Walking speed, m/s. */
  speed = 4.2;
  /** Seconds a lamp needs to see you, up close, to raise the alarm. Farther away it takes longer. */
  detectTime = 0.8;
  /** How much of the alarm fades per second once no lamp sees you. */
  coolRate = 0.5;
  /** How close you must get to a coin to take it. */
  pickupRadius = 0.9;
  /** The thief's size, for walking into things. */
  radius = 0.35;
  /** Seconds the gate takes to rise. */
  gateTime = 1.6;
  private thief: GameObject | null = null;
  private thiefParts = new Set<GameObject>();
  private home: Vec3 = [0, 0, 0];
  private boxes: Box[] = [];
  private lamps: Lamp[] = [];
  private coins: readonly GameObject[] = [];
  private gate: GameObject | null = null;
  private gateBox: Box | null = null;
  private gateY = 0;
  private gateOpen = 0;
  private alarmFill: GameObject | null = null;
  private alarmShape: Shape2D | null = null;
  private status: Text2D | null = null;
  private message: Text2D | null = null;
  private coinSound: AudioSource | null = null;
  private caughtSound: AudioSource | null = null;
  private gateSound: AudioSource | null = null;
  private winSound: AudioSource | null = null;
  private taken = 0;
  private alarm = 0;
  private watched = false;
  private caughtFor = 0;
  private escaped = false;
  private elapsed = 0;
  private stride = 0;

  start(): void {
    const scene = this.scene;
    this.thief = scene.findByName('Thief');
    this.thief?.traverse((o) => void this.thiefParts.add(o));
    if (this.thief) this.home = vec3.clone(this.thief.transform.position);
    // Everything solid is a leaf mesh under Solid: a box to walk into, if it stands on the ground (not a roof or a
    // lintel overhead) and is more than ankle high.
    scene.findByName('Solid')?.traverse((o) => {
      if (!o.mesh || o.children.length > 0) return;
      const b = worldBounds(o);
      if (b && b.min[1] < 1.3 && b.max[1] > 0.3) this.boxes.push(b);
    });
    scene.findByName('Towers')?.traverse((o) => {
      if (o.light) this.lamps.push({ object: o, light: o.light });
    });
    this.coins = scene.findByName('Coins')?.children ?? [];
    this.gate = scene.findByName('Gate Bars');
    if (this.gate) {
      this.gateBox = worldBounds(this.gate);
      this.gateY = this.gate.transform.position[1];
    }
    this.alarmFill = scene.findByName('Alarm Fill');
    this.alarmShape = this.alarmFill?.getComponent(Shape2D) ?? null;
    this.status = scene.findByName('Status')?.getComponent(Text2D) ?? null;
    this.message = scene.findByName('Message')?.getComponent(Text2D) ?? null;
    const sound = (name: string) => scene.findByName(name)?.getComponent(AudioSource) ?? null;
    this.coinSound = sound('Coin Sound');
    this.caughtSound = sound('Caught Sound');
    this.gateSound = sound('Gate Sound');
    this.winSound = sound('Win Sound');
    this.restart();
  }

  get coinsTaken(): number {
    return this.taken;
  }

  get alarmLevel(): number {
    return this.alarm;
  }

  /** Whether a lamp saw the thief in the last frame. */
  get seen(): boolean {
    return this.watched;
  }

  get hasEscaped(): boolean {
    return this.escaped;
  }

  restart(): void {
    this.taken = 0;
    this.alarm = 0;
    this.caughtFor = 0;
    this.escaped = false;
    this.elapsed = 0;
    this.gateOpen = 0;
    for (const coin of this.coins) coin.setActive(true);
    if (this.thief) this.thief.transform.position = vec3.clone(this.home);
    this.moveGate();
    this.say('Take every coin, then slip out through the gate.\\nStay in the shadows.');
    this.showStatus();
  }

  update(dt: number, time: number): void {
    if (input.pressed('KeyR')) this.restart();
    this.spinCoins(time);
    if (this.taken === this.coins.length && this.gateOpen < 1) {
      this.gateOpen = Math.min(1, this.gateOpen + dt / this.gateTime);
      this.moveGate();
    }
    if (this.caughtFor > 0) {
      this.caughtFor -= dt;
      if (this.caughtFor <= 0) this.restart();
      return;
    }
    if (this.escaped) return;
    this.elapsed += dt;
    if (this.elapsed > 4 && this.taken === 0) this.say('');
    this.walk(dt);
    this.takeCoins();
    this.watch(dt);
    const thief = this.thief;
    if (thief && this.gateOpen >= 1 && thief.transform.position[2] < -21) this.escape();
  }

  private walk(dt: number): void {
    const thief = this.thief;
    if (!thief) return;
    // The camera looks north (−Z): W goes away from it.
    const x = input.axis('horizontal'), z = -input.axis('vertical');
    const len = Math.hypot(x, z);
    const p = thief.transform.position;
    if (len > 0) {
      p[0] += (x / len) * this.speed * dt;
      p[2] += (z / len) * this.speed * dt;
      thief.transform.rotation = quat.lookRotation([x, 0, z]);
      this.stride += dt * 10;
    }
    // A little bob while walking.
    p[1] = len > 0 ? Math.abs(Math.sin(this.stride)) * 0.06 : 0;
    for (const b of this.boxes) this.pushOut(p, b);
    if (this.gateBox && this.gateOpen < 0.6) this.pushOut(p, this.gateBox);
    thief.transform.position = p;
  }

  /** Moves the circle at p (in x/z) out of the box, the shortest way. */
  private pushOut(p: Vec3, b: Box): void {
    const r = this.radius;
    const cx = clamp(p[0], b.min[0], b.max[0]), cz = clamp(p[2], b.min[2], b.max[2]);
    const dx = p[0] - cx, dz = p[2] - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r * r) return;
    if (d2 > 1e-8) {
      const d = Math.sqrt(d2);
      p[0] = cx + (dx / d) * r;
      p[2] = cz + (dz / d) * r;
      return;
    }
    // The center is inside: out through the nearest side.
    const exits = [p[0] - b.min[0], b.max[0] - p[0], p[2] - b.min[2], b.max[2] - p[2]];
    const i = exits.indexOf(Math.min(...exits));
    if (i === 0) p[0] = b.min[0] - r;
    else if (i === 1) p[0] = b.max[0] + r;
    else if (i === 2) p[2] = b.min[2] - r;
    else p[2] = b.max[2] + r;
  }

  private spinCoins(time: number): void {
    this.coins.forEach((coin, i) => {
      coin.transform.rotation = quat.fromEulerDeg(90, time * 120 + i * 40, 0);
      coin.transform.position[1] = 0.75 + Math.sin(time * 2.5 + i) * 0.1;
    });
  }

  private takeCoins(): void {
    const p = this.thief?.transform.position;
    if (!p) return;
    for (const coin of this.coins) {
      if (!coin.activeSelf) continue;
      const c = coin.transform.position;
      if (Math.hypot(c[0] - p[0], c[2] - p[2]) > this.pickupRadius) continue;
      coin.setActive(false);
      this.taken++;
      this.coinSound?.playOneShot();
      if (this.taken === this.coins.length) {
        this.say('The gate is open. Get out!');
        this.gateSound?.playOneShot();
      }
      this.showStatus();
    }
  }

  /** Fills the alarm while any lamp sees the thief, faster the closer it is; it fades out of sight. */
  private watch(dt: number): void {
    const thief = this.thief;
    if (!thief) return;
    const p = thief.transform.position;
    let rate = 0;
    for (const lamp of this.lamps) {
      // The chest or the head is enough.
      for (const h of [0.6, 1.25]) {
        const r = this.reach(lamp, [p[0], p[1] + h, p[2]]);
        if (r > 0) {
          rate = Math.max(rate, r);
          break;
        }
      }
    }
    this.watched = rate > 0;
    this.alarm = this.watched ? Math.min(1, this.alarm + (rate / this.detectTime) * dt) : Math.max(0, this.alarm - this.coolRate * dt);
    if (this.alarmFill) this.alarmFill.transform.scale = [Math.max(0.001, this.alarm), 1, 1];
    if (this.alarmShape) this.alarmShape.fillColor = this.watched ? [1, 0.25, 0.15, 1] : [1, 0.75, 0.3, 1];
    if (this.alarm >= 1) this.caught();
  }

  /**
   * How strongly the lamp sees the point: 0 when it's outside the cone or past the range, or when something that
   * casts a shadow is in the way; up to 1 right under the lamp. The same test as the shadow the lamp draws.
   */
  private reach(lamp: Lamp, point: Vec3): number {
    const from = lamp.object.transform.worldPosition;
    const to = vec3.sub(point, from);
    const dist = vec3.length(to);
    if (dist >= lamp.light.range || dist < 1e-3) return 0;
    const dir = vec3.scale(to, 1 / dist);
    const cos = vec3.dot(dir, lamp.object.transform.forward);
    if (cos < Math.cos((lamp.light.outerAngle * Math.PI) / 180)) return 0;
    const hit = raycastScene(this.scene, { origin: from, dir }, (o) =>
      o.castShadows && !this.thiefParts.has(o) && (o.material === null || o.material.blend === 'opaque'));
    if (hit && hit.distance < dist - 0.2) return 0;
    return 1 - 0.6 * (dist / lamp.light.range);
  }

  private caught(): void {
    this.caughtFor = 1.6;
    this.say('Caught! Back to the start.');
    this.caughtSound?.playOneShot();
  }

  private escape(): void {
    this.escaped = true;
    const s = Math.floor(this.elapsed);
    this.say('Escaped with every coin in ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') + '!\\nR: play again');
    this.winSound?.playOneShot();
  }

  private moveGate(): void {
    if (!this.gate) return;
    const t = this.gateOpen * this.gateOpen * (3 - 2 * this.gateOpen);
    this.gate.transform.position[1] = this.gateY + t * 3.2;
  }

  private showStatus(): void {
    if (this.status) this.status.text = 'Coins ' + this.taken + ' / ' + this.coins.length;
  }

  private say(text: string): void {
    if (this.message) this.message.text = text;
  }
}
`;

const SEARCHLIGHT_SCRIPT = `import { Script, quat } from 'messier';

/** Swings a watchtower lamp from side to side, tipped down toward the garden. */
export default class Searchlight extends Script {
  /** Compass direction the swing centers on, degrees (0 = −Z, 90 = +X). */
  heading = 0;
  /** How far it swings each way, degrees. */
  sweep = 30;
  /** How far below the horizon it points, degrees. */
  tilt = 30;
  /** Seconds for a swing there and back. */
  period = 7;
  /** Where in the swing it starts, 0…1. */
  phase = 0;

  update(_dt: number, time: number): void {
    const yaw = ((this.heading + this.sweep * Math.sin((time / this.period + this.phase) * Math.PI * 2)) * Math.PI) / 180;
    const tilt = (this.tilt * Math.PI) / 180;
    this.transform.rotation = quat.lookRotation([Math.sin(yaw) * Math.cos(tilt), -Math.sin(tilt), -Math.cos(yaw) * Math.cos(tilt)]);
  }
}
`;

const FOLLOW_SCRIPT = `import { Script, vec3, type GameObject, type Vec3 } from 'messier';

/** Keeps the camera above and behind the thief, easing after it. */
export default class Follow extends Script {
  height = 13;
  back = 7;
  /** How quickly it catches up: higher is snappier. */
  ease = 4;
  private target: GameObject | null = null;
  private focus: Vec3 = [0, 0, 0];

  start(): void {
    this.target = this.scene.findByName('Thief');
    if (this.target) this.focus = vec3.clone(this.target.transform.position);
    this.place(1);
  }

  lateUpdate(dt: number): void {
    this.place(1 - Math.exp(-this.ease * dt));
  }

  private place(t: number): void {
    if (!this.target) return;
    this.focus = vec3.lerp(this.focus, this.target.transform.position, t);
    this.transform.position = vec3.add(this.focus, [0, this.height, this.back]);
    this.transform.lookAt(vec3.add(this.focus, [0, 0.8, 0]));
  }
}
`;

const FLICKER_SCRIPT = `import { Script } from 'messier';

/** Makes a fire's light (and its flame, a child named Flame) waver. */
export default class Flicker extends Script {
  /** How much the brightness wavers, as a fraction of it. */
  amount = 0.25;
  /** Wavers per second, roughly. */
  rate = 7;
  private base = 0;
  private flameScale = 1;

  start(): void {
    this.base = this.object.light?.intensity ?? 0;
    this.flameScale = this.object.find('Flame')?.transform.scale[1] ?? 1;
  }

  update(_dt: number, time: number): void {
    const t = time * this.rate;
    // Two waves out of step read as fire rather than a pulse.
    const f = 1 + this.amount * (0.6 * Math.sin(t) + 0.4 * Math.sin(t * 2.37 + 1.3));
    if (this.object.light) this.object.light.intensity = this.base * f;
    const flame = this.object.find('Flame');
    if (flame) flame.transform.scale = [flame.transform.scale[0], this.flameScale * (0.8 + 0.25 * f), flame.transform.scale[2]];
  }
}
`;

const FIREFLY_SCRIPT = `import { Script, vec3, type Vec3 } from 'messier';

/** Drifts around where it was placed, and blinks. */
export default class Firefly extends Script {
  /** How far it wanders, m. */
  wander = 1.2;
  /** Seconds per loop. */
  period = 9;
  /** Where in the loop it starts, 0…1. */
  phase = 0;
  private home: Vec3 = [0, 0, 0];

  start(): void {
    this.home = vec3.clone(this.transform.position);
  }

  update(_dt: number, time: number): void {
    const a = (time / this.period + this.phase) * Math.PI * 2;
    this.transform.position = vec3.add(this.home, [Math.sin(a) * this.wander, Math.sin(a * 3) * 0.3, Math.sin(a * 2) * this.wander * 0.6]);
    const blink = 0.5 + 0.5 * Math.sin(a * 7);
    const s = 0.35 + 0.65 * blink;
    this.transform.scale = [s, s, s];
  }
}
`;

export const HEIST_SCRIPTS: ScriptList = [
  ['Heist', HEIST_SCRIPT],
  ['Searchlight', SEARCHLIGHT_SCRIPT],
  ['Follow', FOLLOW_SCRIPT],
  ['Flicker', FLICKER_SCRIPT],
  ['Firefly', FIREFLY_SCRIPT],
];
