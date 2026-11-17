import { AudioSource, Script, Signal, input, raycastScene, vec3, type Vec3 } from 'messier';

/** Rolls the ball with WASD / arrows relative to the camera, jumps with Space and respawns after a fall. */
export default class PlayerBall extends Script {
  /** Rolling force in newtons. */
  force = 16;
  /** Upward speed of a jump, in m/s. */
  jumpSpeed = 5.5;
  /** Falling below this height counts as falling off. */
  killHeight = -5;
  /** Emitted when the ball falls off and respawns. */
  readonly fell = new Signal<[]>();
  private spawn: Vec3 = [0, 0, 0];
  private jumpQueued = false;
  private grounded = false;

  awake(): void {
    this.object.addToGroup('player');
  }

  start(): void {
    this.spawn = this.transform.worldPosition;
  }

  update(): void {
    // Read taps in update(): a frame can run zero fixed steps, and fixedUpdate() would miss the press.
    if (input.pressed('Space')) this.jumpQueued = true;
  }

  fixedUpdate(): void {
    const body = this.object.rigidBody;
    if (!body) return;
    const pos = this.transform.worldPosition;
    if (pos[1] < this.killHeight) {
      // Moving a dynamic body by hand counts as a teleport: the solver wakes it and zeroes its velocity.
      this.transform.worldPosition = this.spawn;
      this.jumpQueued = false;
      this.fell.emit();
      return;
    }

    // Camera-relative directions, flattened onto the ground.
    const cam = this.scene.activeCamera()?.transform;
    const forward = flat(cam ? cam.forward : [0, 0, -1]);
    const right = flat(cam ? cam.right : [1, 0, 0]);
    const x = input.axis('horizontal');
    const z = input.axis('vertical');
    if (x || z) body.addForce(vec3.scale(vec3.normalize(vec3.add(vec3.scale(right, x), vec3.scale(forward, z))), this.force));

    // Grounded when a physical object is right below the ball (the ray starts inside it, so skip itself).
    const hit = raycastScene(this.scene, { origin: pos, dir: [0, -1, 0] }, (o) => o !== this.object && o.rigidBody !== null);
    this.grounded = hit !== null && hit.distance < body.radius * this.transform.scale[1] + 0.1;
    if (this.jumpQueued && this.grounded) {
      body.addImpulse([0, (this.jumpSpeed - body.velocity[1]) * body.mass, 0]);
      this.object.getComponent(AudioSource)?.playOneShot();
    }
    this.jumpQueued = false;
  }
}

function flat(v: Vec3): Vec3 {
  const f: Vec3 = [v[0], 0, v[2]];
  return vec3.length(f) > 1e-4 ? vec3.normalize(f) : [0, 0, -1];
}
