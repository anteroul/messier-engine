import { Script, vec3, type GameObject, type Vec3 } from 'messier';

/** Trails the player from above and behind, smoothed so physics jitter doesn't shake the view. */
export default class FollowCamera extends Script {
  height = 7;
  distance = 9;
  /** How quickly the camera catches up, per second. */
  stiffness = 4;
  private target: GameObject | null = null;

  start(): void {
    this.target = this.scene.getGroup('player')[0] ?? null;
    if (this.target) this.transform.worldPosition = this.goal(this.target.transform.worldPosition);
  }

  // After every update and physics step, so it sees where the ball ended up this frame.
  lateUpdate(dt: number): void {
    if (!this.target) return;
    const p = this.target.transform.worldPosition;
    const k = 1 - Math.exp(-this.stiffness * dt); // frame-rate independent smoothing
    this.transform.worldPosition = vec3.lerp(this.transform.worldPosition, this.goal(p), k);
    this.transform.lookAt(p);
  }

  private goal(p: Vec3): Vec3 {
    return [p[0], Math.max(p[1], 0) + this.height, p[2] + this.distance];
  }
}
