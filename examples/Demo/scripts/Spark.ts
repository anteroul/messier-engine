import { GameObject, Script, vec3, type Vec3 } from 'messier';

/** A short-lived particle: flies, bounces off the floor, shrinks and destroys itself. */
export default class Spark extends Script {
  /** Seconds before it disappears. */
  life = 0.7;
  gravity = 14;
  private velocity: Vec3 = [0, 0, 0];
  private age = 0;
  private size = 1;

  launch(velocity: Vec3): void {
    this.velocity = vec3.clone(velocity);
  }

  start(): void {
    this.size = this.transform.scale[0];
  }

  update(dt: number): void {
    this.age += dt;
    if (this.age >= this.life) {
      GameObject.destroy(this.object);
      return;
    }
    this.velocity[1] -= this.gravity * dt;
    const p = vec3.addScaled(this.transform.position, this.velocity, dt);
    if (p[1] < 0.05 && this.velocity[1] < 0) this.velocity[1] *= -0.5;
    this.transform.position = p;
    const s = this.size * (1 - this.age / this.life);
    this.transform.scale = [s, s, s];
  }
}
