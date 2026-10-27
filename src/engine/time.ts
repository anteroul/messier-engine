// Frame timing and the fixed-timestep accumulator. `Engine.step` calls beginFrame() once per frame and runs the
// returned number of fixed steps (physics + fixedUpdate), calling fixedStepDone() after each.

export const DEFAULT_FIXED_RATE = 60;
export const DEFAULT_MAX_SUBSTEPS = 8;
// Accumulated frame times are rarely exact multiples of the step (3 × 1/60 ≠ 0.05 in floating point).
const STEP_EPSILON = 1e-9;

export class Clock {
  /** Multiplies deltaTime and the time fed to fixed steps. 0 pauses the game; unscaled values keep running. */
  timeScale = 1;
  /** Most fixed steps per frame. Time beyond that is dropped, so a slow frame can't snowball into slower ones. */
  maxSubsteps = DEFAULT_MAX_SUBSTEPS;

  private _fixedDeltaTime = 1 / DEFAULT_FIXED_RATE;
  private _deltaTime = 0;
  private _unscaledDeltaTime = 0;
  private _time = 0;
  private _unscaledTime = 0;
  private _fixedTime = 0;
  private _frameCount = 0;
  private _accumulator = 0;

  /** Scaled seconds since the last frame. */
  get deltaTime(): number {
    return this._deltaTime;
  }
  get unscaledDeltaTime(): number {
    return this._unscaledDeltaTime;
  }
  /** Scaled seconds since reset() (the start of Play). */
  get time(): number {
    return this._time;
  }
  get unscaledTime(): number {
    return this._unscaledTime;
  }
  /** Simulated seconds after the fixed steps run so far. */
  get fixedTime(): number {
    return this._fixedTime;
  }
  /** Frames since reset(). */
  get frameCount(): number {
    return this._frameCount;
  }

  /** Seconds per fixed step. */
  get fixedDeltaTime(): number {
    return this._fixedDeltaTime;
  }
  set fixedDeltaTime(dt: number) {
    if (!(dt > 0) || !Number.isFinite(dt)) throw new RangeError(`fixedDeltaTime must be positive, got ${dt}`);
    this._fixedDeltaTime = dt;
  }

  /** Fixed steps per second. */
  get fixedRate(): number {
    return 1 / this._fixedDeltaTime;
  }
  set fixedRate(hz: number) {
    this.fixedDeltaTime = 1 / hz;
  }

  /**
   * How far the current frame is between the last fixed step and the next one (0…1). Renderers can blend the
   * previous and current physics poses with it.
   */
  get alpha(): number {
    return Math.min(1, this._accumulator / this._fixedDeltaTime);
  }

  /** Back to zero (start of Play). Keeps timeScale, fixedDeltaTime and maxSubsteps. */
  reset(): void {
    this._deltaTime = this._unscaledDeltaTime = 0;
    this._time = this._unscaledTime = this._fixedTime = 0;
    this._frameCount = 0;
    this._accumulator = 0;
  }

  /** Advances by a real frame time (seconds) and returns how many fixed steps to run this frame. */
  beginFrame(unscaledDt: number): number {
    const dt = Math.max(0, unscaledDt);
    this._unscaledDeltaTime = dt;
    this._deltaTime = dt * this.timeScale;
    this._unscaledTime += dt;
    this._time += this._deltaTime;
    this._frameCount++;

    const step = this._fixedDeltaTime;
    this._accumulator += this._deltaTime;
    let steps = Math.floor((this._accumulator + STEP_EPSILON) / step);
    if (steps > this.maxSubsteps) {
      steps = Math.max(0, this.maxSubsteps);
      // Drop the backlog but keep the fraction, so alpha stays meaningful.
      this._accumulator = (this._accumulator - steps * step) % step;
    } else {
      this._accumulator = Math.max(0, this._accumulator - steps * step);
    }
    return steps;
  }

  /** Called by the engine after each fixed step it ran. */
  fixedStepDone(): void {
    this._fixedTime += this._fixedDeltaTime;
  }
}

/** The engine's clock. */
export const Time = new Clock();
