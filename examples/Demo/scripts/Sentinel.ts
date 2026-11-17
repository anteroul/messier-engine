import { Script, vec3, type GameObject, type Scene, type Signal, type Vec3 } from 'messier';

/** A kinematic block sliding back and forth. Touching it knocks the ball away and costs a point. */
export default class Sentinel extends Script {
  /** Distance from the middle of the patrol to each end. */
  range = 4;
  /** Patrol cycles per second. */
  speed = 0.25;
  knockback = 7;
  penalty = 1;
  /** Seconds after a hit before it can hit again. */
  cooldown = 1;
  private origin: Vec3 = [0, 0, 0];
  private axis: Vec3 = [1, 0, 0];
  private phase = 0;
  private recharge = 0;
  private player: GameObject | null = null;
  private game: GameApi | null = null;

  start(): void {
    this.origin = vec3.clone(this.transform.position);
    this.axis = this.transform.right; // patrol along the block's own X axis, as placed in the editor
    this.player = this.scene.getGroup('player')[0] ?? null;
    this.game = findScript<GameApi>(this.scene, 'GameManager');
    // Sentinels rest while the round is won: disabling a behaviour stops its updates and calls onDisable().
    this.game?.won.connect(() => (this.enabled = false), this);
    this.game?.restarted.connect(() => (this.enabled = true), this);
  }

  fixedUpdate(dt: number): void {
    // Moving a kinematic body's transform is enough: the solver derives its velocity and pushes the ball.
    this.phase += dt * this.speed * Math.PI * 2;
    this.transform.position = vec3.addScaled(this.origin, this.axis, Math.sin(this.phase) * this.range);

    this.recharge = Math.max(0, this.recharge - dt);
    const body = this.player?.rigidBody;
    if (!this.player || !body || this.recharge > 0) return;
    const away = vec3.sub(this.player.transform.worldPosition, this.transform.worldPosition);
    if (vec3.length(away) > 1.05) return;
    away[1] = 0;
    body.addImpulse(vec3.scale(vec3.normalize(away), this.knockback * body.mass));
    body.addImpulse([0, 2 * body.mass, 0]);
    this.game?.addPoints(-this.penalty);
    this.recharge = this.cooldown;
  }

  update(): void {
    const m = this.object.material;
    if (m) m.emissiveStrength = 1 + 8 * (this.recharge / this.cooldown);
  }

  onDisable(): void {
    const m = this.object.material;
    if (m) m.emissiveStrength = 0.2;
  }

  onEnable(): void {
    const m = this.object.material;
    if (m) m.emissiveStrength = 1;
  }
}

interface GameApi {
  addPoints(n: number): void;
  won: Signal<[]>;
  restarted: Signal<[]>;
}

function findScript<T>(scene: Scene, name: string): T | null {
  return (scene.query(Script).find((s) => s.typeName === name) as unknown as T | undefined) ?? null;
}
