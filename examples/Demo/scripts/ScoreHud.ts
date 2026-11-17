import { Script, Text2D, type Scene, type Signal } from 'messier';

/** Writes the score and the win message into this object's Text2D, and pops the text when the score changes. */
export default class ScoreHud extends Script {
  /** Font size multiplier right after a change. */
  pop = 1.4;
  /** How fast the pop settles, per second. */
  settle = 4;
  private label: Text2D | null = null;
  private baseSize = 0;
  private boost = 0;
  private goal = 0;
  private finished = false;

  start(): void {
    this.label = this.object.getComponent(Text2D);
    if (this.label) this.baseSize = this.label.fontSize;
    const game = findScript<GameApi>(this.scene, 'GameManager');
    if (!game) return;
    this.goal = game.goal;
    this.show(game.points);
    game.scoreChanged.connect((score, goal) => {
      this.goal = goal;
      this.show(score);
      this.boost = 1;
    }, this);
    game.won.connect(() => {
      this.finished = true;
      this.show(this.goal);
    }, this);
    game.restarted.connect(() => {
      this.finished = false;
      this.show(0);
    }, this);
  }

  update(dt: number): void {
    if (!this.label) return;
    this.boost = Math.max(0, this.boost - dt * this.settle);
    this.label.fontSize = this.baseSize * (1 + (this.pop - 1) * this.boost);
  }

  private show(score: number): void {
    if (!this.label) return;
    this.label.text = this.finished ? 'You win!\nPress R to play again' : `Gems ${score} / ${this.goal}`;
  }
}

interface GameApi {
  readonly points: number;
  readonly goal: number;
  scoreChanged: Signal<[score: number, goal: number]>;
  won: Signal<[]>;
  restarted: Signal<[]>;
}

function findScript<T>(scene: Scene, name: string): T | null {
  return (scene.query(Script).find((s) => s.typeName === name) as unknown as T | undefined) ?? null;
}
