import type { ScriptList } from '../demos/shared';

// The Material Lab's scripts (source strings, as they'd be written in the Scripts tab). Both scenes share them.

const LAB_SCRIPT = `import { Script, Text2D, input, sceneManager, type Material, type Texture } from 'messier';

interface Maps {
  material: Material;
  normal: Texture | null;
  metallicRoughness: Texture | null;
  occlusion: Texture | null;
  emissive: Texture | null;
  glow: number;
}

/**
 * Runs the lab: Space takes every map but the base color off all materials (and puts them back), emissive maps
 * pulse, and N / P load the next and previous scene.
 */
export default class Lab extends Script {
  /** Glow pulses per second. */
  pulseRate = 0.4;
  /** How far the glow dips in a pulse: 0 keeps it steady, 1 lets it go dark. */
  pulseDepth = 0.55;
  private maps: Maps[] = [];
  private mapsOn = true;
  private status: Text2D | null = null;

  start(): void {
    const seen = new Set<Material>();
    this.scene.traverse((o) => {
      const m = o.material;
      if (!m || seen.has(m)) return;
      seen.add(m);
      this.maps.push({
        material: m,
        normal: m.normalTexture,
        metallicRoughness: m.metallicRoughnessTexture,
        occlusion: m.occlusionTexture,
        emissive: m.emissiveTexture,
        glow: m.emissiveStrength,
      });
    });
    this.status = this.scene.findByName('Status')?.getComponent(Text2D) ?? null;
    this.showStatus();
  }

  get mapsShown(): boolean {
    return this.mapsOn;
  }

  update(_dt: number, time: number): void {
    if (input.pressed('Space')) this.toggleMaps();
    if (input.pressed('KeyN')) this.loadScene(1);
    if (input.pressed('KeyP')) this.loadScene(-1);
    // A slow breath, between full strength and (1 - pulseDepth) of it.
    const pulse = 1 - this.pulseDepth * (0.5 - 0.5 * Math.cos(time * this.pulseRate * Math.PI * 2));
    for (const m of this.maps) if (m.emissive && this.mapsOn) m.material.emissiveStrength = m.glow * pulse;
  }

  toggleMaps(): void {
    this.mapsOn = !this.mapsOn;
    for (const m of this.maps) {
      const mat = m.material;
      mat.normalTexture = this.mapsOn ? m.normal : null;
      mat.metallicRoughnessTexture = this.mapsOn ? m.metallicRoughness : null;
      mat.occlusionTexture = this.mapsOn ? m.occlusion : null;
      mat.emissiveTexture = this.mapsOn ? m.emissive : null;
      // Without its map an emissive color would light the whole surface, so the glow goes with it.
      if (m.emissive) mat.emissiveStrength = this.mapsOn ? m.glow : 0;
    }
    this.showStatus();
  }

  private loadScene(step: number): void {
    const count = sceneManager.sceneCount;
    if (count < 2 || sceneManager.isLoading) return;
    void sceneManager.loadScene((sceneManager.activeSceneIndex + step + count) % count);
  }

  private showStatus(): void {
    if (this.status) this.status.text = this.mapsOn ? 'Maps: on' : 'Maps: base color only';
  }
}
`;

const SWEEP_SCRIPT = `import { Script, vec3, type Vec3 } from 'messier';

/** Swings the object from side to side (and a little up and down), so the light it carries rakes across the scene. */
export default class Sweep extends Script {
  /** How far it swings each way, meters. */
  width = 5;
  /** Seconds for a swing there and back. */
  period = 10;
  /** How far it rises and falls, meters. */
  bob = 0.5;
  private origin: Vec3 = [0, 0, 0];

  start(): void {
    this.origin = vec3.clone(this.transform.position);
  }

  update(_dt: number, time: number): void {
    const a = (time / this.period) * Math.PI * 2;
    const o = this.origin;
    this.transform.position = [o[0] + Math.sin(a) * this.width, o[1] + Math.sin(a * 2) * this.bob, o[2]];
  }
}
`;

const SPIN_SCRIPT = `import { Script } from 'messier';

/** Turns the object around its vertical axis, tilted by tilt degrees. */
export default class Spin extends Script {
  /** Degrees per second. */
  speed = 20;
  /** Tilt of the axis, degrees. */
  tilt = 0;
  private angle = 0;

  start(): void {
    this.angle = this.transform.getEulerDeg()[1];
  }

  update(dt: number): void {
    this.angle = (this.angle + this.speed * dt) % 360;
    this.transform.setEulerDeg(this.tilt, this.angle, 0);
  }
}
`;

const ORBIT_SCRIPT = `import { Script, quat } from 'messier';

/** Circles a directional light around the scene, so the light (and the sky's sun) comes from every side in turn. */
export default class Orbit extends Script {
  /** Seconds for a full circle. */
  period = 24;
  /** Height of the light above the horizon, degrees. */
  elevation = 24;
  private startAngle = 0;

  start(): void {
    const forward = this.transform.forward;
    this.startAngle = Math.atan2(-forward[2], -forward[0]);
  }

  update(_dt: number, time: number): void {
    const a = this.startAngle + (time / this.period) * Math.PI * 2;
    const e = (this.elevation * Math.PI) / 180;
    // Lights shine along their local -Z: aim it from its place on the circle at the centre.
    this.transform.rotation = quat.lookRotation([-Math.cos(a) * Math.cos(e), -Math.sin(e), -Math.sin(a) * Math.cos(e)]);
  }
}
`;

export const LAB_SCRIPTS: ScriptList = [
  ['Lab', LAB_SCRIPT],
  ['Sweep', SWEEP_SCRIPT],
  ['Spin', SPIN_SCRIPT],
  ['Orbit', ORBIT_SCRIPT],
];
