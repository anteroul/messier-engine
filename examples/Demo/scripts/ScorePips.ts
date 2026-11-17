import { Script, type Scene, type Signal } from 'messier';

/** Lights one child lamp per point, and runs a chase across them after a win. */
export default class ScorePips extends Script {
  /** Emissive strength of a lit lamp. */
  glow = 5;
  /** How fast lamps fade in and out, per second. */
  fade = 8;
  private lit = 0;
  private celebrating = false;

  start(): void {
    const game = findScript<GameApi>(this.scene, 'GameManager');
    if (!game) return;
    this.lit = game.points;
    game.scoreChanged.connect((score) => (this.lit = score), this);
    game.won.connect(() => (this.celebrating = true), this);
    game.restarted.connect(() => (this.celebrating = false), this);
  }

  update(dt: number, time: number): void {
    const lamps = this.object.children;
    const k = Math.min(1, this.fade * dt);
    lamps.forEach((lamp, i) => {
      const m = lamp.material;
      if (!m) return;
      const target = this.celebrating ? this.glow * (0.5 + 0.5 * Math.sin(time * 10 - i * 0.8)) : i < this.lit ? this.glow : 0;
      m.emissiveStrength += (target - m.emissiveStrength) * k;
    });
  }
}

interface GameApi {
  readonly points: number;
  scoreChanged: Signal<[score: number, goal: number]>;
  won: Signal<[]>;
  restarted: Signal<[]>;
}

function findScript<T>(scene: Scene, name: string): T | null {
  return (scene.query(Script).find((s) => s.typeName === name) as unknown as T | undefined) ?? null;
}
