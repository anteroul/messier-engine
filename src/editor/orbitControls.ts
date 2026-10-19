import { clamp, vec3, type Camera, type Vec3 } from '../engine';

/** Orbit / pan / zoom / fly camera controller for the editor viewport. */
export class OrbitControls {
  yaw = 0;
  pitch = 0;
  distance = 10;
  orbitSpeed = 0.005;
  flySpeed = 6;

  private goalTarget: Vec3 | null = null;
  private goalDistance: number | null = null;

  constructor(private readonly camera: Camera) {
    this.syncFromCamera();
  }

  /** Re-derives yaw/pitch/distance from the camera's position and target. */
  syncFromCamera(): void {
    const offset = vec3.sub(this.camera.position, this.camera.target);
    this.distance = Math.max(0.01, vec3.length(offset));
    this.yaw = Math.atan2(offset[0], offset[2]);
    this.pitch = Math.asin(clamp(offset[1] / this.distance, -1, 1));
  }

  private apply(): void {
    const cp = Math.cos(this.pitch);
    const offset: Vec3 = [cp * Math.sin(this.yaw), Math.sin(this.pitch), cp * Math.cos(this.yaw)];
    this.camera.position = vec3.addScaled(this.camera.target, offset, this.distance);
  }

  orbit(dxPx: number, dyPx: number): void {
    this.yaw -= dxPx * this.orbitSpeed;
    this.pitch = clamp(this.pitch + dyPx * this.orbitSpeed, -1.55, 1.55);
    this.goalTarget = null;
    this.apply();
  }

  pan(dxPx: number, dyPx: number, viewportHeight: number): void {
    const s = this.camera.worldPerPixel(this.camera.target, viewportHeight);
    const f = this.camera.forward();
    const right = vec3.normalize(vec3.cross(f, [0, 1, 0]));
    const up = vec3.cross(right, f);
    const delta = vec3.add(vec3.scale(right, -dxPx * s), vec3.scale(up, dyPx * s));
    this.camera.target = vec3.add(this.camera.target, delta);
    this.goalTarget = null;
    this.apply();
  }

  zoom(wheelDelta: number): void {
    this.distance = clamp(this.distance * Math.exp(wheelDelta * 0.0012), 0.2, 400);
    this.goalDistance = null;
    this.apply();
  }

  /** Moves camera and target together. `move` is (right, up, forward) in -1..1. */
  fly(move: Vec3, dt: number, fast: boolean): void {
    if (move[0] === 0 && move[1] === 0 && move[2] === 0) return;
    const f = this.camera.forward();
    const right = vec3.normalize(vec3.cross(f, [0, 1, 0]));
    const speed = this.flySpeed * (fast ? 3 : 1) * Math.max(0.3, this.distance / 10) * dt;
    let d = vec3.scale(right, move[0] * speed);
    d = vec3.addScaled(d, [0, 1, 0], move[1] * speed);
    d = vec3.addScaled(d, f, move[2] * speed);
    this.camera.target = vec3.add(this.camera.target, d);
    this.goalTarget = null;
    this.apply();
  }

  /** Smoothly frames a point with the given radius. */
  focus(center: Vec3, radius: number): void {
    this.goalTarget = vec3.clone(center);
    this.goalDistance = clamp(radius * 2.8, 1, 200);
  }

  update(dt: number): void {
    if (!this.goalTarget && this.goalDistance === null) return;
    const k = 1 - Math.exp(-dt * 12);
    if (this.goalTarget) {
      this.camera.target = vec3.lerp(this.camera.target, this.goalTarget, k);
      if (vec3.distance(this.camera.target, this.goalTarget) < 1e-3) this.goalTarget = null;
    }
    if (this.goalDistance !== null) {
      this.distance += (this.goalDistance - this.distance) * k;
      if (Math.abs(this.distance - this.goalDistance) < 1e-3) this.goalDistance = null;
    }
    this.apply();
  }
}
