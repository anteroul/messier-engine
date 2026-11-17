import { Script, Signal } from 'messier';

/** Turns the object around its Y axis and announces every full turn. */
export default class Carousel extends Script {
  /** Degrees per second. */
  speed = 90;
  /** Emitted after each full turn, with the number of turns so far. */
  readonly lap = new Signal<[laps: number]>();
  private angle = 0;
  private laps = 0;

  update(dt: number): void {
    this.angle += this.speed * dt;
    this.transform.setEulerDeg(0, this.angle, 0);
    if (this.angle >= (this.laps + 1) * 360) this.lap.emit(++this.laps);
  }
}
