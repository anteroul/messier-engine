import { Renderer, type RenderStats } from './renderer';
import { Scene, type GameObject } from './scene';
import { Camera } from './camera';
import { OverlayBuilder } from './overlay';
import { input } from './input';

export interface FrameInfo {
  dt: number;
  /** Seconds since the engine started. */
  time: number;
  /** Seconds since Play mode started (0 when not playing). */
  playTime: number;
}

type FrameCallback = (frame: FrameInfo) => void;

/** Owns the main loop: update behaviours + physics -> world matrices -> hooks -> render. */
export class Engine {
  readonly scene = new Scene();
  /** Free view (the editor's viewport camera), used when no scene camera is in use. */
  readonly camera = new Camera();
  /** Render through the scene's active camera (Scene.activeCamera) when it has one, instead of `camera`. */
  useSceneCamera = true;
  /** The scene camera the current frame is rendered through, or null when it uses `camera`. */
  viewObject: GameObject | null = null;
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
  private readonly sceneView = new Camera();
  private readonly beforeRenderHooks: FrameCallback[] = [];
  private readonly afterRenderHooks: ((stats: RenderStats) => void)[] = [];

  private constructor(readonly renderer: Renderer) {}

  static async create(canvas: HTMLCanvasElement): Promise<Engine> {
    return new Engine(await Renderer.create(canvas));
  }

  /** Called every frame after the scene update and before rendering (build overlay here). */
  /** The view the current frame is rendered from: the scene camera's, or `camera`. */
  get view(): Camera {
    return this.viewObject ? this.sceneView : this.camera;
  }

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
    // Keys held across Play/Stop would otherwise stay down in the next session.
    input.reset();
    if (playing) this.scene.physics.reset(this.scene);
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
    input.endFrame();
    // After the update, so a camera moved by a behaviour is rendered where it is now.
    const camObj = this.useSceneCamera ? this.scene.activeCamera() : null;
    this.viewObject = camObj;
    // Shadows are centered on view.target: put it where the shadow box covers most of what the camera sees.
    camObj?.camera!.applyTo(this.sceneView, camObj.worldMatrix, this.scene.shadowExtent * 0.6);
    const view = this.view;
    const canvas = this.renderer.canvas;
    // Hidden viewport (e.g. the editor's Scripts tab): keep simulating, skip drawing.
    if (canvas.clientWidth === 0 || canvas.clientHeight === 0) return;
    view.aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    this.overlay.begin(view, canvas.clientHeight);
    const frame: FrameInfo = { dt, time: this.time, playTime: this.playTime };
    for (const cb of this.beforeRenderHooks) cb(frame);

    const stats = this.renderer.render(this.scene, view, {
      time: this.time,
      // The grid is an editing aid, not part of the game's view.
      grid: this.showGrid && !camObj,
      overlay: this.overlay,
    });
    for (const cb of this.afterRenderHooks) cb(stats);
  }
}
