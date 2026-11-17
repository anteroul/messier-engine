import { AudioSource, Script, Shape2D, Text2D, audio, clamp, input, vec3, type GameObject, type Quat, type Vec3 } from 'messier';

/** Aims and fires the cannon, counts what has gone over the edge, and puts everything back on R. */
export default class Topple extends Script {
  /** Aiming speed, degrees per second. */
  turnSpeed = 38;
  /** Muzzle speed of a tap, m/s. */
  minPower = 13;
  /** Muzzle speed of a full charge. */
  maxPower = 30;
  /** Seconds of holding Space for a full charge. */
  chargeTime = 1.1;
  /** Cannonballs per round. */
  shots = 7;
  /** Anything below this height has fallen off the terrace. */
  edgeHeight = -1.5;
  private pieces: Piece[] = [];
  private balls: readonly GameObject[] = [];
  private dots: readonly GameObject[] = [];
  private pips: Shape2D[] = [];
  private yawPivot: GameObject | null = null;
  private pitchPivot: GameObject | null = null;
  private muzzle: GameObject | null = null;
  private powerBar: GameObject | null = null;
  private status: Text2D | null = null;
  private message: Text2D | null = null;
  private yaw = 0;
  private pitch = 18;
  private charge = 0;
  private charging = false;
  private left = 0;
  private toppled = 0;
  private idols = 0;
  private idolsDown = 0;
  private sinceShot = 0;
  private recoil = 0;
  private over = false;
  private cannonSound: AudioSource | null = null;
  private fallSound: AudioSource | null = null;
  private idolSound: AudioSource | null = null;
  private winSound: AudioSource | null = null;

  start(): void {
    const scene = this.scene;
    for (const object of scene.findByName('Blocks')?.children ?? []) {
      const idol = object.name.startsWith('Idol');
      if (idol) this.idols++;
      this.pieces.push({ object, idol, down: false, position: vec3.clone(object.transform.position), rotation: [...object.transform.rotation] as Quat });
    }
    this.balls = scene.findByName('Balls')?.children ?? [];
    this.dots = scene.findByName('Aim Dots')?.children ?? [];
    this.yawPivot = scene.findByName('Turret');
    this.pitchPivot = this.yawPivot?.find('Cradle') ?? null;
    this.muzzle = this.pitchPivot?.find('Muzzle') ?? null;
    this.powerBar = scene.findByName('Power Fill');
    this.status = scene.findByName('Status')?.getComponent(Text2D) ?? null;
    this.message = scene.findByName('Message')?.getComponent(Text2D) ?? null;
    const sound = (name: string) => scene.findByName(name)?.getComponent(AudioSource) ?? null;
    this.cannonSound = sound('Cannon Sound');
    this.fallSound = sound('Fall Sound');
    this.idolSound = sound('Idol Sound');
    this.winSound = sound('Win Sound');
    for (const pip of scene.findByName('Shots')?.children ?? []) {
      const shape = pip.getComponent(Shape2D);
      if (shape) this.pips.push(shape);
    }
    this.restart();
  }

  get shotsLeft(): number {
    return this.left;
  }

  get fallen(): number {
    return this.toppled;
  }

  get idolsFallen(): number {
    return this.idolsDown;
  }

  get finished(): boolean {
    return this.over;
  }

  restart(): void {
    for (const piece of this.pieces) {
      const o = piece.object, body = o.rigidBody;
      piece.down = false;
      o.setActive(true);
      o.transform.position = vec3.clone(piece.position);
      o.transform.rotation = [...piece.rotation] as Quat;
      if (body) {
        body.velocity = [0, 0, 0];
        body.angularVelocity = [0, 0, 0];
        // Forget the old pose, or the solver would take the move for a teleport mid-flight.
        body.resetState();
      }
    }
    for (const ball of this.balls) ball.setActive(false);
    this.left = Math.min(this.shots, this.balls.length);
    this.toppled = this.idolsDown = 0;
    this.charge = this.sinceShot = 0;
    this.charging = this.over = false;
    if (this.message) this.message.text = '';
    this.showStatus();
  }

  update(dt: number): void {
    if (input.pressed('KeyR')) this.restart();
    this.yaw = clamp(this.yaw - input.axis('horizontal') * this.turnSpeed * dt, -38, 38);
    this.pitch = clamp(this.pitch + input.axis('vertical') * this.turnSpeed * dt, 2, 60);
    this.yawPivot?.transform.setEulerDeg(0, this.yaw, 0);
    this.pitchPivot?.transform.setEulerDeg(this.pitch, 0, 0);
    // The barrel kicks back when it fires and slides out again.
    this.recoil = Math.max(0, this.recoil - dt * 2.5);
    const barrel = this.pitchPivot?.find('Barrel');
    if (barrel) barrel.transform.position[2] = -0.9 + this.recoil * 0.45;

    if (!this.over && this.left > 0 && input.isDown('Space')) {
      this.charging = true;
      this.charge = Math.min(1, this.charge + dt / this.chargeTime);
    } else if (this.charging) {
      this.fire();
    }
    this.sinceShot += dt;
    this.showAim();
    this.watchPieces();
    if (this.powerBar) this.powerBar.transform.scale[0] = Math.max(0.001, this.charge);
  }

  private aim(): { from: Vec3; velocity: Vec3 } | null {
    if (!this.pitchPivot || !this.muzzle) return null;
    const from = this.muzzle.transform.worldPosition;
    const dir = vec3.normalize(vec3.sub(from, this.pitchPivot.transform.worldPosition));
    return { from, velocity: vec3.scale(dir, this.minPower + (this.maxPower - this.minPower) * this.charge) };
  }

  private fire(): void {
    const aim = this.aim();
    const ball = this.balls.find((b) => !b.activeSelf);
    this.charging = false;
    if (!aim || !ball || !ball.rigidBody) return;
    ball.setActive(true);
    ball.transform.position = aim.from;
    ball.rigidBody.resetState();
    ball.rigidBody.velocity = aim.velocity;
    ball.rigidBody.angularVelocity = [-6, 0, 0];
    // A full charge booms deeper.
    if (this.cannonSound) {
      this.cannonSound.pitch = 1.3 - 0.5 * this.charge;
      this.cannonSound.playOneShot();
    }
    this.charge = 0;
    this.left--;
    this.sinceShot = 0;
    this.recoil = 1;
    this.showStatus();
  }

  /** Lays the dots along the path the next ball would take. */
  private showAim(): void {
    const aim = this.aim();
    const show = !!aim && !this.over && this.left > 0;
    this.dots.forEach((dot, i) => {
      dot.setActive(show);
      if (!aim || !show) return;
      const t = 0.07 * (i + 1);
      dot.transform.position = [aim.from[0] + aim.velocity[0] * t, aim.from[1] + aim.velocity[1] * t - 4.905 * t * t, aim.from[2] + aim.velocity[2] * t];
    });
  }

  private watchPieces(): void {
    let changed = false;
    for (const piece of this.pieces) {
      const y = piece.object.transform.position[1];
      if (!piece.down && y < this.edgeHeight) {
        piece.down = changed = true;
        this.toppled++;
        if (piece.idol) this.idolsDown++;
        // Heard from where it went over (not through its source: one sound for every block).
        const clip = piece.idol ? this.idolSound?.clip : this.fallSound?.clip;
        if (clip) audio.play(clip, { position: piece.object.transform.worldPosition, volume: piece.idol ? 0.9 : 0.6, minDistance: 6, maxDistance: 70 });
      }
      // Far below, out of sight under the water.
      if (piece.object.activeSelf && y < -14) piece.object.setActive(false);
    }
    for (const ball of this.balls) {
      if (ball.activeSelf && ball.transform.position[1] < -14) ball.setActive(false);
    }
    if (changed) this.showStatus();
    if (this.over) return;
    if (this.idols > 0 && this.idolsDown >= this.idols) {
      this.finish('TERRACE CLEARED\n' + this.left + ' shots to spare');
      this.winSound?.playOneShot();
    }
    else if (this.left === 0 && this.sinceShot > 7) this.finish('OUT OF SHOT\n' + this.idolsDown + ' of ' + this.idols + ' idols down');
  }

  private finish(text: string): void {
    this.over = true;
    if (this.message) this.message.text = text + '\n\nR to set it up again';
  }

  private showStatus(): void {
    if (this.status) this.status.text = 'Idols ' + this.idolsDown + ' / ' + this.idols + '\nBlocks ' + this.toppled;
    this.pips.forEach((pip, i) => {
      pip.fillColor[3] = i < this.left ? 1 : 0.15;
    });
  }
}

interface Piece {
  object: GameObject;
  idol: boolean;
  down: boolean;
  position: Vec3;
  rotation: Quat;
}
