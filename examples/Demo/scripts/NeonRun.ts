import { AudioSource, CameraComponent, Script, Shape2D, Text2D, clamp, input, type GameObject } from 'messier';

/** Runs the whole game: scrolls the pooled scenery past the ship, places barriers and rings, keeps score. */
export default class NeonRun extends Script {
  /** Speed at the start, m/s. */
  startSpeed = 28;
  topSpeed = 70;
  /** Speed gained per second. */
  acceleration = 0.8;
  /** Sideways speed at full stick, m/s. */
  steerSpeed = 12;
  /** How far from the middle of the road the ship can go. */
  roadHalf = 5;
  /** Hits the ship can take. */
  shields = 3;
  /** Distance between rows of barriers. */
  rowGap = 30;
  /** Where rows appear, in front of the ship. */
  spawnDistance = 190;
  /** Points for flying through a ring. */
  ringBonus = 250;
  private ship: GameObject | null = null;
  private hull: GameObject | null = null;
  private cam: GameObject | null = null;
  private barriers: readonly GameObject[] = [];
  private rings: readonly GameObject[] = [];
  private trail: readonly GameObject[] = [];
  private scrollers: Scroller[] = [];
  private pips: Shape2D[] = [];
  private flash: Shape2D | null = null;
  private scoreText: Text2D | null = null;
  private message: Text2D | null = null;
  private engine: AudioSource | null = null;
  private ringSound: AudioSource | null = null;
  private crashSound: AudioSource | null = null;
  private camX = 0;
  private camY = 0;
  private camZ = 0;
  private x = 0;
  private vx = 0;
  private speed = 0;
  private distance = 0;
  private bonus = 0;
  private left = 0;
  private untilRow = 0;
  private safe = 0;
  private shake = 0;
  private flashAlpha = 0;
  private nextTrail = 0;
  private trailTimer = 0;
  private lastLane = 2;

  start(): void {
    const scene = this.scene;
    this.ship = scene.findByName('Ship');
    this.hull = this.ship?.find('Hull') ?? null;
    this.cam = scene.findByName('Run Camera');
    this.barriers = scene.findByName('Barriers')?.children ?? [];
    this.rings = scene.findByName('Rings')?.children ?? [];
    this.trail = scene.findByName('Trail')?.children ?? [];
    // Scenery that repeats: each group's children sit 'spacing' apart along Z and wrap around behind the camera.
    for (const name of ['Cross Lines', 'Gates', 'Towers']) {
      const parent = scene.findByName(name);
      if (!parent || parent.children.length < 2) continue;
      const spacing = Math.abs(parent.children[1].transform.position[2] - parent.children[0].transform.position[2]);
      this.scrollers.push({ items: parent.children, span: spacing * parent.children.length });
    }
    for (const pip of scene.findByName('Shields')?.children ?? []) {
      const shape = pip.getComponent(Shape2D);
      if (shape) this.pips.push(shape);
    }
    this.flash = scene.findByName('Flash')?.getComponent(Shape2D) ?? null;
    this.scoreText = scene.findByName('Score')?.getComponent(Text2D) ?? null;
    this.message = scene.findByName('Message')?.getComponent(Text2D) ?? null;
    this.engine = scene.findByName('Engine Sound')?.getComponent(AudioSource) ?? null;
    this.ringSound = scene.findByName('Ring Sound')?.getComponent(AudioSource) ?? null;
    this.crashSound = scene.findByName('Crash Sound')?.getComponent(AudioSource) ?? null;
    if (this.cam) [this.camX, this.camY, this.camZ] = this.cam.transform.position;
    this.restart();
  }

  get score(): number {
    return Math.floor(this.distance) + this.bonus;
  }

  get shieldsLeft(): number {
    return this.left;
  }

  restart(): void {
    this.x = this.vx = this.distance = this.bonus = 0;
    this.speed = this.startSpeed;
    this.left = this.shields;
    this.safe = 0;
    this.shake = 0;
    for (const o of this.barriers) o.setActive(false);
    for (const o of this.rings) o.setActive(false);
    // Fill the road ahead, leaving a calm stretch to get going.
    for (let z = 70; z < this.spawnDistance; z += this.rowGap) this.spawnRow(-z);
    this.untilRow = this.rowGap;
    this.hull?.setActive(true);
    this.showShields();
    if (this.message) this.message.text = 'A / D  or  arrows to steer';
  }

  update(dt: number, time: number): void {
    if (input.pressed('KeyR')) this.restart();
    const alive = this.left > 0;
    if (alive) {
      this.speed = Math.min(this.topSpeed, this.speed + this.acceleration * dt);
      this.vx += (input.axis('horizontal') * this.steerSpeed - this.vx) * Math.min(1, dt * 9);
      this.x = clamp(this.x + this.vx * dt, -this.roadHalf, this.roadHalf);
      if (Math.abs(this.x) >= this.roadHalf) this.vx = 0;
      if (this.message && this.distance > 120) this.message.text = '';
    } else {
      this.speed *= Math.exp(-dt * 1.5);
      this.vx *= Math.exp(-dt * 4);
    }
    const move = this.speed * dt;
    this.distance += alive ? move : 0;
    this.safe = Math.max(0, this.safe - dt);

    for (const s of this.scrollers) {
      for (const o of s.items) {
        const p = o.transform.position;
        p[2] += move;
        if (p[2] > 14) p[2] -= s.span;
      }
    }
    this.untilRow -= move;
    if (this.untilRow <= 0) {
      this.spawnRow(-this.spawnDistance);
      this.untilRow += this.rowGap;
    }
    for (const o of this.barriers) {
      if (!o.activeSelf) continue;
      const p = o.transform.position, size = o.transform.scale;
      p[2] += move;
      if (p[2] > 14) o.setActive(false);
      else if (alive && this.safe <= 0 && Math.abs(p[2]) < size[2] / 2 + 0.8 && Math.abs(p[0] - this.x) < size[0] / 2 + 0.4) this.crash();
    }
    for (const o of this.rings) {
      if (!o.activeSelf) continue;
      const p = o.transform.position;
      p[2] += move;
      o.transform.setEulerDeg(0, time * 140, 0);
      if (p[2] > 14) o.setActive(false);
      else if (alive && Math.abs(p[2]) < 1 && Math.abs(p[0] - this.x) < 1.3) {
        o.setActive(false);
        this.bonus += this.ringBonus;
        this.flashAlpha = 0.18;
        this.setFlashColor(1, 0.85, 0.3);
        this.ringSound?.playOneShot();
      }
    }
    // The engine drone rises with speed and dies down with the ship.
    if (this.engine) {
      this.engine.pitch = 0.7 + 0.9 * clamp(this.speed / this.topSpeed, 0, 1);
      this.engine.volume += ((alive ? 0.5 : 0) - this.engine.volume) * Math.min(1, dt * 3);
    }
    this.moveShip(dt, time, alive);
    this.moveCamera(dt, time);
    this.updateHud(dt);
  }

  private crash(): void {
    this.left--;
    this.safe = 1.6;
    this.shake = 1;
    this.flashAlpha = 0.55;
    this.setFlashColor(1, 0.15, 0.3);
    this.speed = Math.max(this.startSpeed * 0.7, this.speed * 0.6);
    this.showShields();
    this.crashSound?.playOneShot(null, this.left > 0 ? 0.6 : 1);
    if (this.left <= 0) {
      this.hull?.setActive(false);
      if (this.message) this.message.text = 'WRECKED\nScore ' + this.score + '\n\nR to fly again';
    }
  }

  /** A row across the five lanes: barriers with at least one lane left open, sometimes a ring in the open one. */
  private spawnRow(z: number): void {
    // The open lane moves at most two lanes between rows, so every gap can be reached.
    const open = clamp(this.lastLane + Math.floor(Math.random() * 5) - 2, 0, 4);
    this.lastLane = open;
    const crowd = 0.35 + 0.3 * (this.speed - this.startSpeed) / Math.max(1, this.topSpeed - this.startSpeed);
    for (let lane = 0; lane < 5; lane++) {
      if (lane === open || Math.random() > crowd) continue;
      const free = this.barriers.filter((o) => !o.activeSelf);
      if (free.length === 0) break;
      const o = free[Math.floor(Math.random() * free.length)];
      o.transform.position = [(lane - 2) * 2.5, o.transform.scale[1] / 2, z];
      o.setActive(true);
    }
    if (Math.random() < 0.6) {
      const ring = this.rings.find((o) => !o.activeSelf);
      if (ring) {
        ring.transform.position = [(open - 2) * 2.5, 1, z];
        ring.setActive(true);
      }
    }
  }

  private moveShip(dt: number, time: number, alive: boolean): void {
    const ship = this.ship;
    if (!ship) return;
    ship.transform.position = [this.x, 0.75 + Math.sin(time * 3) * 0.07, 0];
    ship.transform.setEulerDeg(0, -this.vx * 1.4, -this.vx * 3.2);
    // Blink while the shield recharges.
    if (alive) this.hull?.setActive(this.safe <= 0 || Math.floor(this.safe * 12) % 2 === 0);

    // The exhaust: segments dropped behind the engine that drift back and thin out.
    this.trailTimer -= dt;
    if (alive && this.trailTimer <= 0 && this.trail.length > 0) {
      this.trailTimer = 0.03;
      const seg = this.trail[this.nextTrail];
      this.nextTrail = (this.nextTrail + 1) % this.trail.length;
      // Alternate between the two engines.
      seg.transform.position = [this.x + (this.nextTrail % 2 === 0 ? -0.3 : 0.3), 0.72, 1.6];
      seg.transform.scale = [0.16, 0.05, 1.3];
      seg.setActive(true);
    }
    for (const seg of this.trail) {
      if (!seg.activeSelf) continue;
      const s = seg.transform.scale;
      seg.transform.position[2] += this.speed * 0.35 * dt;
      s[0] -= dt * 0.4;
      if (s[0] <= 0.02) seg.setActive(false);
    }
  }

  private moveCamera(dt: number, time: number): void {
    const cam = this.cam;
    if (!cam) return;
    this.shake = Math.max(0, this.shake - dt * 2.2);
    const k = this.shake * this.shake * 0.5;
    cam.transform.position = [
      this.camX + this.x * 0.6 + Math.sin(time * 71) * k,
      this.camY + Math.sin(time * 93) * k,
      this.camZ,
    ];
    cam.transform.setEulerDeg(-7, 0, -this.vx * 0.5);
    const lens = cam.getComponent(CameraComponent);
    // The view widens with speed.
    if (lens) lens.fovDeg = 62 + 24 * (this.speed - this.startSpeed) / Math.max(1, this.topSpeed - this.startSpeed);
  }

  private updateHud(dt: number): void {
    if (this.scoreText) this.scoreText.text = String(this.score).padStart(6, '0') + '\n' + Math.round(this.speed * 3.6) + ' km/h';
    this.flashAlpha = Math.max(0, this.flashAlpha - dt * 1.2);
    if (this.flash) this.flash.fillColor[3] = this.flashAlpha;
  }

  private setFlashColor(r: number, g: number, b: number): void {
    if (this.flash) this.flash.fillColor = [r, g, b, this.flashAlpha];
  }

  private showShields(): void {
    this.pips.forEach((pip, i) => {
      pip.fillColor[3] = i < this.left ? 1 : 0.12;
    });
  }
}

interface Scroller {
  items: readonly GameObject[];
  span: number;
}
