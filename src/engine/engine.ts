import { Renderer, type RenderStats } from './renderer';
import { Scene } from './scene';
import { Camera } from './camera';
import { OverlayBuilder } from './overlay';

export interface FrameInfo {
  dt: number;
  /** Seconds since the engine started. */
  time: number;
  /** Seconds since Play mode started (0 when not playing). */
  playTime: number;
}

type FrameCallback = (frame: FrameInfo) => void;

/** Owns the main loop: update behaviours -> world matrices -> hooks -> render. */
export class Engine {
  readonly scene = new Scene();
  readonly camera = new Camera();
  readonly overlay = new OverlayBuilder();
  playing = false;
  showGrid = true;
  fps = 0;

  private time = 0;
  private playTime = 0;
  private last = 0;
  private frameHandle = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private readonly beforeRenderHooks: FrameCallback[] = [];
  private readonly afterRenderHooks: ((stats: RenderStats) => void)[] = [];

  private constructor(readonly renderer: Renderer) {}

  static async create(canvas: HTMLCanvasElement): Promise<Engine> {
    return new Engine(await Renderer.create(canvas));
  }

  /** Called every frame after the scene update and before rendering (build overlay here). */
  onBeforeRender(cb: FrameCallback): void {
    this.beforeRenderHooks.push(cb);
  }

  onAfterRender(cb: (stats: RenderStats) => void): void {
    this.afterRenderHooks.push(cb);
  }

  setPlaying(playing: boolean): void {
    if (playing === this.playing) return;
    this.playing = playing;
    this.playTime = 0;
  }

  start(): void {
    if (this.frameHandle) return;
    this.last = performance.now();
    const tick = (now: number) => {
      this.frameHandle = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.step(dt);
    };
    this.frameHandle = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.frameHandle);
    this.frameHandle = 0;
  }

  private step(dt: number): void {
    this.time += dt;
    if (this.playing) this.playTime += dt;
    this.fpsAccum += dt;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }

    this.scene.update(dt, this.playTime, this.playing);
    const canvas = this.renderer.canvas;
    this.camera.aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    this.overlay.begin(this.camera, canvas.clientHeight);
    const frame: FrameInfo = { dt, time: this.time, playTime: this.playTime };
    for (const cb of this.beforeRenderHooks) cb(frame);

    const stats = this.renderer.render(this.scene, this.camera, {
      time: this.time,
      grid: this.showGrid,
      overlay: this.overlay,
    });
    for (const cb of this.afterRenderHooks) cb(stats);
  }
}
