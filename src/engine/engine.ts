import { Renderer, type RenderStats } from './renderer';
import { Scene, type GameObject } from './scene';
import { Camera } from './camera';
import { OverlayBuilder } from './overlay';
import { input } from './input';
import { Signal } from './signal';
import { Time } from './time';

export interface FrameInfo {
  dt: number;
  /** Seconds since the engine started. */
  time: number;
  /** Seconds since Play mode started (Time.time; 0 when not playing). */
  playTime: number;
  /** Fixed-step interpolation factor (Time.alpha). */
  alpha: number;
}

type FrameCallback = (frame: FrameInfo) => void;

/**
 * Owns the main loop. Each frame, while playing: fixed steps (fixedUpdate, physics) → update → lateUpdate; then
 * input edges reset, world matrices sync, hooks, render, and deferred destroys. Input itself arrives as DOM events
 * between frames, so it's current before the frame starts.
 */
export class Engine {
  /** Emitted after the active scene changes. */
  readonly sceneChanged = new Signal<[scene: Scene, previous: Scene]>();
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

  private _scene = new Scene();
  private time = 0;
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

  /** The active scene: the one that updates and renders. */
  get scene(): Scene {
    return this._scene;
  }

  /**
   * Makes `scene` the active one. While playing, the previous scene stops running (onDisable/onDestroy) and the new
   * one starts. Scenes are plain objects, so keep the ones you want to return to.
   */
  setActiveScene(scene: Scene): void {
    const prev = this._scene;
    if (scene === prev) return;
    if (this.playing) {
      prev.setRunning(false);
      scene.physics.reset(scene);
      scene.setRunning(true);
    }
    this._scene = scene;
    this.viewObject = null;
    this.sceneChanged.emit(scene, prev);
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
    Time.reset();
    // Keys held across Play/Stop would otherwise stay down in the next session.
    input.reset();
    if (playing) this.scene.physics.reset(this.scene);
    this.scene.setRunning(playing);
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
    this.fpsAccum += dt;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }

    const scene = this._scene;
    if (this.playing) {
      const steps = Time.beginFrame(dt);
      for (let i = 0; i < steps; i++) {
        scene.fixedUpdate(Time.fixedDeltaTime);
        Time.fixedStepDone();
      }
      scene.updateBehaviours(Time.deltaTime, Time.time);
      scene.lateUpdate(Time.deltaTime);
    }
    input.endFrame();
    scene.updateMatrices();
    this.render(scene, dt);
    scene.processDestroyed();
  }

  private render(scene: Scene, dt: number): void {
    // After the update, so a camera moved by a behaviour is rendered where it is now.
    const camObj = this.useSceneCamera ? scene.activeCamera() : null;
    this.viewObject = camObj;
    // Shadows are centered on view.target: put it where the shadow box covers most of what the camera sees.
    camObj?.camera!.applyTo(this.sceneView, camObj.worldMatrix, scene.shadowExtent * 0.6);
    const view = this.view;
    const canvas = this.renderer.canvas;
    // Hidden viewport (e.g. the editor's Scripts tab): keep simulating, skip drawing.
    if (canvas.clientWidth === 0 || canvas.clientHeight === 0) return;
    view.aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    this.overlay.begin(view, canvas.clientHeight);
    const frame: FrameInfo = { dt, time: this.time, playTime: this.playing ? Time.time : 0, alpha: this.playing ? Time.alpha : 0 };
    for (const cb of this.beforeRenderHooks) cb(frame);

    const stats = this.renderer.render(scene, view, {
      time: this.time,
      alpha: frame.alpha,
      // The grid is an editing aid, not part of the game's view.
      grid: this.showGrid && !camObj,
      overlay: this.overlay,
    });
    for (const cb of this.afterRenderHooks) cb(stats);
  }
}
