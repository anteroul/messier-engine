import { Script, vec3, type Vec3 } from 'messier';

/** Floats the object along a figure-eight around where it starts. */
export default class Hover extends Script {
  /** Width of the loop in meters. */
  size = 0.8;
  /** Loops per second. */
  speed = 0.2;
  private home: Vec3 = [0, 0, 0];

  start(): void {
    this.home = vec3.clone(this.object.transform.position);
  }

  update(dt: number, time: number): void {
    const a = time * this.speed * Math.PI * 2;
    const offset: Vec3 = [Math.sin(a) * this.size, Math.sin(a * 2) * 0.15, Math.sin(a * 2) * this.size * 0.5];
    this.object.transform.position = vec3.add(this.home, offset);
  }
}
