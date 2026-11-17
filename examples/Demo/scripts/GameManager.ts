import { AudioSource, Script, Signal, Time, input, type GameObject } from 'messier';

/** Keeps the score, runs the win and restart flow, and tells everyone through signals. */
export default class GameManager extends Script {
  /** Gems needed to win. */
  goal = 10;
  /** Points lost when the ball falls off the arena. */
  fallPenalty = 2;
  /** Time scale right after winning; it eases back to 1. */
  slowMotion = 0.2;
  /** Seconds (real time) the slow motion lasts. */
  slowMotionTime = 2;
  readonly scoreChanged = new Signal<[score: number, goal: number]>();
  readonly won = new Signal<[]>();
  readonly restarted = new Signal<[]>();
  private score = 0;
  private finished = false;
  private slowTimer = 0;

  get points(): number {
    return this.score;
  }

  start(): void {
    // Groups are joined in awake(), which has run for every object by the time anything starts.
    const player = this.scene.getGroup('player')[0] as GameObject | undefined;
    const ball = player?.getComponents(Script).find((s) => s.typeName === 'PlayerBall') as unknown as PlayerApi | undefined;
    ball?.fell.connect(() => this.addPoints(-this.fallPenalty), this);
  }

  addPoints(n: number): void {
    if (this.finished) return;
    const score = Math.max(0, Math.min(this.goal, this.score + n));
    if (score === this.score) return;
    this.score = score;
    this.scoreChanged.emit(score, this.goal);
    if (score < this.goal) return;
    this.finished = true;
    this.slowTimer = this.slowMotionTime;
    Time.timeScale = this.slowMotion;
    console.log('Gem Rush: you win! Press R to play again.');
    this.object.getComponent(AudioSource)?.play();
    this.won.emit();
  }

  restart(): void {
    this.score = 0;
    this.finished = false;
    this.slowTimer = 0;
    Time.timeScale = 1;
    this.scoreChanged.emit(0, this.goal);
    this.restarted.emit();
  }

  update(): void {
    if (this.slowTimer > 0) {
      // Unscaled time, or slow motion would also slow down its own timer.
      this.slowTimer = Math.max(0, this.slowTimer - Time.unscaledDeltaTime);
      const t = 1 - this.slowTimer / this.slowMotionTime;
      Time.timeScale = this.slowTimer > 0 ? this.slowMotion + (1 - this.slowMotion) * t * t : 1;
    }
    if (input.pressed('KeyR')) this.restart();
  }

  onDestroy(): void {
    // Time outlives Play, so put the clock back when the game stops.
    Time.timeScale = 1;
  }
}

interface PlayerApi {
  fell: Signal<[]>;
}
