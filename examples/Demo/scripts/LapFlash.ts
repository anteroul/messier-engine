import { Script, type Signal } from 'messier';

/** Flashes the object's material each time the Carousel it rides on completes a turn. */
export default class LapFlash extends Script {
  /** Extra emissive strength right after a lap. */
  peak = 8;
  /** How fast the flash fades, per second. */
  fade = 6;
  private glow = 0;

  start(): void {
    // Scripts can't import each other: find the Carousel on the parent by name and describe the part we use.
    const carousel = this.object.parent?.getComponents(Script).find((s) => s.typeName === 'Carousel') as unknown as
      | { lap: Signal<[laps: number]> }
      | undefined;
    // With this script as the owner, the listener is disconnected when the script is destroyed.
    carousel?.lap.connect(() => (this.glow = this.peak), this);
  }

  update(dt: number): void {
    this.glow = Math.max(0, this.glow - this.fade * dt);
    const m = this.object.material;
    if (m) m.emissiveStrength = 0.5 + this.glow;
  }
}
