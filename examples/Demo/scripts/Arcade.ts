import { AudioSource, Light, Script, Text2D, audio, input, sceneManager, type GameObject, type Vec4 } from 'messier';

/** Picks a game with A/D or the arrow keys and loads its scene with Enter or Space. A stand is named after its scene. */
export default class Arcade extends Script {
  /** Turning speed of the chosen showpiece, degrees per second. */
  spinSpeed = 55;
  /** Spotlight intensity over the chosen stand, and over the others. */
  brightLight = 260;
  dimLight = 24;
  /** How fast the camera and lights follow the choice. */
  follow = 6;
  private stands: Stand[] = [];
  private index = 0;
  private focus = 0;
  private time = 0;
  private camera: GameObject | null = null;
  private status: Text2D | null = null;
  private selectSound: AudioSource | null = null;
  private launchSound: AudioSource | null = null;

  start(): void {
    const scene = this.scene;
    for (const object of scene.findByName('Stands')?.children ?? []) {
      const title = object.find('Title')?.getComponent(Text2D) ?? null;
      const blurb = object.find('Blurb')?.getComponent(Text2D) ?? null;
      this.stands.push({
        object,
        piece: object.find('Piece'),
        light: object.find('Spot')?.getComponent(Light) ?? null,
        title,
        blurb,
        titleColor: title ? [...title.color] as Vec4 : [1, 1, 1, 1],
        level: 0,
        angle: 0,
      });
    }
    this.camera = scene.findByName('Arcade Camera');
    this.status = scene.findByName('Status')?.getComponent(Text2D) ?? null;
    this.selectSound = scene.findByName('Select Sound')?.getComponent(AudioSource) ?? null;
    this.launchSound = scene.findByName('Launch Sound')?.getComponent(AudioSource) ?? null;
    // Coming back from a game, its stand is the chosen one.
    const from = Arcade.last;
    const at = this.stands.findIndex((s) => s.object.name === from);
    if (at >= 0) this.index = at;
    this.focus = this.stands[this.index]?.object.transform.position[0] ?? 0;
    this.showStatus();
  }

  /** Name of the chosen game's scene. */
  get selectedName(): string {
    return this.stands[this.index]?.object.name ?? '';
  }

  /** Whether the chosen scene is in the build that's playing. */
  get available(): boolean {
    return this.buildIndex(this.selectedName) >= 0;
  }

  update(dt: number): void {
    const count = this.stands.length;
    if (count === 0) return;
    const step = (input.pressed('KeyD') || input.pressed('ArrowRight') ? 1 : 0) - (input.pressed('KeyA') || input.pressed('ArrowLeft') ? 1 : 0);
    if (step !== 0) {
      this.index = (this.index + step + count) % count;
      this.showStatus();
      this.selectSound?.playOneShot();
    }
    if ((input.pressed('Enter') || input.pressed('Space')) && this.available && !sceneManager.isLoading) {
      Arcade.last = this.selectedName;
      // Not through the source: its sounds stop when this scene unloads, and this one should carry over.
      const launch = this.launchSound;
      if (launch?.clip) audio.play(launch.clip, { volume: launch.volume });
      void sceneManager.loadScene(this.selectedName);
    }

    this.time += dt;
    const ease = Math.min(1, dt * this.follow);
    this.stands.forEach((stand, i) => {
      stand.level += ((i === this.index ? 1 : 0) - stand.level) * ease;
      const k = stand.level;
      stand.angle = (stand.angle + dt * (10 + this.spinSpeed * k)) % 360;
      if (stand.piece) {
        const size = 0.82 + 0.18 * k;
        stand.piece.transform.setEulerDeg(0, stand.angle, 0);
        stand.piece.transform.position[1] = 1.45 + 0.18 * k + Math.sin(this.time * 2.2 + i) * 0.05;
        stand.piece.transform.scale = [size, size, size];
      }
      if (stand.light) stand.light.intensity = this.dimLight + (this.brightLight - this.dimLight) * k;
      const c = stand.titleColor;
      if (stand.title) stand.title.color = [c[0], c[1], c[2], 0.3 + 0.7 * k];
      if (stand.blurb) stand.blurb.color = [1, 1, 1, 0.85 * k];
    });

    const target = this.stands[this.index].object.transform.position[0];
    this.focus += (target - this.focus) * ease;
    if (this.camera) {
      this.camera.transform.position = [this.focus * 0.62, 2.6, 10.4];
      this.camera.transform.lookAt([this.focus, 2.05, 0]);
    }
  }

  private buildIndex(name: string): number {
    for (let i = 0; i < sceneManager.sceneCount; i++) if (sceneManager.sceneName(i) === name) return i;
    return -1;
  }

  private showStatus(): void {
    if (!this.status) return;
    this.status.text = this.available ? 'Enter: play ' + this.selectedName : this.selectedName + ' is not in this build';
    this.status.color = this.available ? [1, 1, 1, 0.9] : [1, 0.6, 0.5, 0.9];
  }

  /** The game launched last. Static, so it outlives the scene change. */
  private static last = '';
}

interface Stand {
  object: GameObject;
  piece: GameObject | null;
  light: Light | null;
  title: Text2D | null;
  blurb: Text2D | null;
  titleColor: Vec4;
  level: number;
  angle: number;
}
