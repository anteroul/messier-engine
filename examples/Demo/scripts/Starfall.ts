import { AudioSource, Light, Script, Shape2D, Text2D, audio, clamp, input, quat, type GameObject, type Vec3 } from 'messier';

/** Flies the ship, fires bolts, sends asteroids down the field and blows them up. */
export default class Starfall extends Script {
  /** Ship speed, m/s. */
  speed = 13;
  /** Seconds between bolts while Space is held. */
  fireInterval = 0.13;
  boltSpeed = 46;
  /** Seconds between asteroids at the start, and at full difficulty. */
  spawnInterval = 0.9;
  minSpawnInterval = 0.28;
  /** Seconds until full difficulty. */
  rampTime = 90;
  lives = 3;
  /** Half the width of the field. */
  fieldHalf = 10;
  private ship: GameObject | null = null;
  private hull: GameObject | null = null;
  private bolts: readonly GameObject[] = [];
  private rocks: Rock[] = [];
  private sparks: Spark[] = [];
  private flashes: Flash[] = [];
  private layers: StarLayer[] = [];
  private pips: Shape2D[] = [];
  private scoreText: Text2D | null = null;
  private message: Text2D | null = null;
  private x = 0;
  private z = 2;
  private vx = 0;
  private points = 0;
  private left = 0;
  private elapsed = 0;
  private cooldown = 0;
  private untilRock = 0;
  private safe = 0;
  private side = 1;
  private gunSound: AudioSource | null = null;
  private hitSound: AudioSource | null = null;
  private boomSound: AudioSource | null = null;
  private damageSound: AudioSource | null = null;

  start(): void {
    const scene = this.scene;
    this.ship = scene.findByName('Ship');
    this.hull = this.ship?.find('Hull') ?? null;
    this.bolts = scene.findByName('Bolts')?.children ?? [];
    for (const object of scene.findByName('Asteroids')?.children ?? []) {
      this.rocks.push({ object, radius: 1, hp: 1, velocity: [0, 0, 0], axis: [0, 1, 0], spin: 0, angle: 0 });
    }
    for (const object of scene.findByName('Sparks')?.children ?? []) this.sparks.push({ object, velocity: [0, 0, 0], life: 0 });
    for (const object of scene.findByName('Flashes')?.children ?? []) {
      const light = object.getComponent(Light);
      if (light) this.flashes.push({ object, light, life: 0 });
    }
    // Star layers scroll at their own speed (the 'Far' one slower) and wrap around.
    for (const [name, speed] of [['Near Stars', 16], ['Far Stars', 7]] as [string, number][]) {
      const parent = scene.findByName(name);
      if (parent) this.layers.push({ items: parent.children, speed });
    }
    for (const pip of scene.findByName('Lives')?.children ?? []) {
      const shape = pip.getComponent(Shape2D);
      if (shape) this.pips.push(shape);
    }
    this.scoreText = scene.findByName('Score')?.getComponent(Text2D) ?? null;
    this.message = scene.findByName('Message')?.getComponent(Text2D) ?? null;
    const sound = (name: string) => scene.findByName(name)?.getComponent(AudioSource) ?? null;
    this.gunSound = sound('Gun Sound');
    this.hitSound = sound('Hit Sound');
    this.boomSound = sound('Boom Sound');
    this.damageSound = sound('Damage Sound');
    this.restart();
  }

  get score(): number {
    return this.points;
  }

  get livesLeft(): number {
    return this.left;
  }

  restart(): void {
    this.x = this.vx = this.points = this.elapsed = this.cooldown = this.safe = 0;
    this.z = 2;
    this.left = this.lives;
    this.untilRock = 1;
    for (const o of this.bolts) o.setActive(false);
    for (const r of this.rocks) r.object.setActive(false);
    for (const s of this.sparks) s.object.setActive(false);
    for (const f of this.flashes) f.object.setActive(false);
    this.hull?.setActive(true);
    this.showLives();
    if (this.message) this.message.text = '';
  }

  update(dt: number, time: number): void {
    if (input.pressed('KeyR')) this.restart();
    const alive = this.left > 0;
    this.elapsed += dt;
    this.safe = Math.max(0, this.safe - dt);
    if (alive) this.flyShip(dt, time);
    this.moveBolts(dt);
    this.moveRocks(dt, alive);
    this.moveEffects(dt);
    for (const layer of this.layers) {
      for (const star of layer.items) {
        const p = star.transform.position;
        // The layers lie flat: their local Y is the direction of flight.
        p[1] -= layer.speed * dt;
        if (p[1] < -90) p[1] += 440;
      }
    }
    if (this.scoreText) this.scoreText.text = String(this.points).padStart(6, '0');
  }

  private flyShip(dt: number, time: number): void {
    const ship = this.ship;
    if (!ship) return;
    const steer = input.axis('horizontal');
    this.vx += (steer * this.speed - this.vx) * Math.min(1, dt * 10);
    this.x = clamp(this.x + this.vx * dt, -this.fieldHalf + 1, this.fieldHalf - 1);
    this.z = clamp(this.z - input.axis('vertical') * this.speed * 0.7 * dt, -5, 5);
    ship.transform.position = [this.x, Math.sin(time * 2.4) * 0.08, this.z];
    ship.transform.setEulerDeg(0, 0, -this.vx * 2.6);
    this.hull?.setActive(this.safe <= 0 || Math.floor(this.safe * 12) % 2 === 0);

    this.cooldown -= dt;
    if (input.isDown('Space') && this.cooldown <= 0) {
      const bolt = this.bolts.find((b) => !b.activeSelf);
      if (bolt) {
        // Alternate between the two wing guns.
        this.side = -this.side;
        bolt.transform.position = [this.x + this.side * 0.55, 0, this.z - 0.9];
        bolt.setActive(true);
        this.cooldown = this.fireInterval;
        this.gunSound?.playOneShot();
      }
    }
  }

  private moveBolts(dt: number): void {
    for (const bolt of this.bolts) {
      if (!bolt.activeSelf) continue;
      const p = bolt.transform.position;
      p[2] -= this.boltSpeed * dt;
      if (p[2] < -42) {
        bolt.setActive(false);
        continue;
      }
      for (const rock of this.rocks) {
        if (!rock.object.activeSelf) continue;
        const q = rock.object.transform.position;
        // Bolts are long and fast: test the stretch they covered this frame.
        if (Math.abs(p[0] - q[0]) > rock.radius + 0.15 || Math.abs(p[2] - q[2]) > rock.radius + 0.6 + this.boltSpeed * dt * 0.5) continue;
        bolt.setActive(false);
        this.burst([p[0], 0, q[2] + rock.radius], 3, 0.25);
        if (--rock.hp <= 0) this.shatter(rock);
        else this.playAt(this.hitSound, [p[0], 0, q[2]], 0.5, 1);
        break;
      }
    }
  }

  private moveRocks(dt: number, alive: boolean): void {
    this.untilRock -= dt;
    if (this.untilRock <= 0) {
      const ramp = Math.min(1, this.elapsed / this.rampTime);
      this.untilRock = this.spawnInterval + (this.minSpawnInterval - this.spawnInterval) * ramp;
      this.spawnRock(ramp);
    }
    for (const rock of this.rocks) {
      const o = rock.object;
      if (!o.activeSelf) continue;
      const p = o.transform.position;
      p[0] += rock.velocity[0] * dt;
      p[2] += rock.velocity[2] * dt;
      rock.angle += rock.spin * dt;
      o.transform.rotation = quat.fromAxisAngle(rock.axis, rock.angle);
      if (p[2] > 12) o.setActive(false);
      else if (alive && this.safe <= 0 && Math.hypot(p[0] - this.x, p[2] - this.z) < rock.radius + 0.55) {
        this.shatter(rock);
        this.hit();
      }
    }
  }

  private spawnRock(ramp: number): void {
    const free = this.rocks.filter((r) => !r.object.activeSelf);
    if (free.length === 0) return;
    const rock = free[Math.floor(Math.random() * free.length)];
    const o = rock.object;
    rock.radius = 0.6 + Math.random() * Math.random() * 1.7;
    rock.hp = Math.ceil(rock.radius * 2.2);
    rock.velocity = [(Math.random() - 0.5) * 3, 0, 5 + Math.random() * 5 + ramp * 5];
    rock.axis = normalized([Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5]);
    rock.spin = (Math.random() - 0.5) * 3;
    const r = rock.radius;
    // A little lopsided, so no two look alike.
    o.transform.scale = [r * (0.8 + Math.random() * 0.4), r * (0.75 + Math.random() * 0.3), r * (0.8 + Math.random() * 0.4)];
    o.transform.position = [(Math.random() * 2 - 1) * (this.fieldHalf - 1), 0, -40];
    o.setActive(true);
  }

  private shatter(rock: Rock): void {
    const p = rock.object.transform.position;
    rock.object.setActive(false);
    this.points += Math.round(rock.radius * 10) * 10;
    this.burst([p[0], 0, p[2]], Math.round(6 + rock.radius * 7), rock.radius);
    // Big rocks boom lower and louder.
    this.playAt(this.boomSound, [p[0], 0, p[2]], 0.5 + rock.radius * 0.3, 1.5 - rock.radius * 0.35);
    const flash = this.flashes.find((f) => f.life <= 0) ?? this.flashes[0];
    if (flash) {
      flash.life = 1;
      flash.object.transform.position = [p[0], 1.2, p[2]];
      flash.object.setActive(true);
    }
  }

  /** Throws sparks out from a point. */
  private burst(at: Vec3, count: number, size: number): void {
    for (const spark of this.sparks) {
      if (count <= 0) break;
      if (spark.life > 0) continue;
      count--;
      const a = Math.random() * Math.PI * 2, v = (2 + Math.random() * 9) * (0.6 + size * 0.5);
      spark.velocity = [Math.cos(a) * v, (Math.random() - 0.3) * 5, Math.sin(a) * v + 3];
      spark.life = 0.35 + Math.random() * 0.5;
      spark.object.transform.position = [at[0], at[1], at[2]];
      spark.object.setActive(true);
    }
  }

  private moveEffects(dt: number): void {
    for (const spark of this.sparks) {
      if (spark.life <= 0) continue;
      spark.life -= dt;
      const o = spark.object, p = o.transform.position;
      p[0] += spark.velocity[0] * dt;
      p[1] += spark.velocity[1] * dt;
      p[2] += spark.velocity[2] * dt;
      const s = Math.max(0.02, Math.min(1, spark.life * 3)) * 0.22;
      o.transform.scale = [s, s, s];
      o.transform.setEulerDeg(spark.life * 500, spark.life * 300, 0);
      if (spark.life <= 0) o.setActive(false);
    }
    for (const flash of this.flashes) {
      if (flash.life <= 0) continue;
      flash.life -= dt * 2.6;
      flash.light.intensity = 260 * Math.max(0, flash.life) ** 2;
      if (flash.life <= 0) flash.object.setActive(false);
    }
  }

  /** Plays a source's clip once from a point (the source itself stays put). */
  private playAt(source: AudioSource | null, at: Vec3, volume: number, pitch: number): void {
    if (source?.clip) audio.play(source.clip, { position: at, volume: source.volume * volume, pitch, minDistance: source.minDistance, maxDistance: source.maxDistance });
  }

  private hit(): void {
    this.damageSound?.playOneShot();
    this.left--;
    this.safe = 2;
    this.burst([this.x, 0, this.z], 24, 1.5);
    this.showLives();
    if (this.left <= 0) {
      this.hull?.setActive(false);
      if (this.message) this.message.text = 'SHIP LOST\nScore ' + this.points + '\n\nR to launch again';
    }
  }

  private showLives(): void {
    this.pips.forEach((pip, i) => {
      pip.fillColor[3] = i < this.left ? 1 : 0.12;
    });
  }
}

function normalized(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

interface Rock {
  object: GameObject;
  radius: number;
  hp: number;
  velocity: Vec3;
  axis: Vec3;
  spin: number;
  angle: number;
}

interface Spark {
  object: GameObject;
  velocity: Vec3;
  life: number;
}

interface Flash {
  object: GameObject;
  light: Light;
  life: number;
}

interface StarLayer {
  items: readonly GameObject[];
  speed: number;
}
