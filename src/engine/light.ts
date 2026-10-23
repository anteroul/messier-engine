import type { Vec3 } from './math';

export type LightType = 'directional' | 'point' | 'spot';

export const LIGHT_TYPE_INDEX: Record<LightType, number> = { directional: 0, point: 1, spot: 2 };

/** Fields saved with a scene. Keep in sync with clone(). */
export const LIGHT_FIELDS = ['type', 'color', 'intensity', 'range', 'innerAngle', 'outerAngle', 'castShadows'] as const;

/**
 * Light component. Position and direction come from the owning GameObject:
 * lights shine along the object's local -Z axis.
 */
export class Light {
  type: LightType;
  /** Linear RGB. */
  color: Vec3 = [1, 1, 1];
  intensity: number;
  /** Point / spot: distance at which the light fades to zero. */
  range = 12;
  /** Spot: full-intensity cone half-angle in degrees. */
  innerAngle = 20;
  /** Spot: cut-off cone half-angle in degrees. */
  outerAngle = 30;
  /** Directional only: renders a shadow map (the first such light is used). */
  castShadows = false;

  constructor(type: LightType = 'point', color: Vec3 = [1, 1, 1], intensity?: number) {
    this.type = type;
    this.color = color;
    this.intensity = intensity ?? (type === 'directional' ? 3 : 25);
  }

  clone(): Light {
    const l = new Light(this.type, [...this.color], this.intensity);
    l.range = this.range;
    l.innerAngle = this.innerAngle;
    l.outerAngle = this.outerAngle;
    l.castShadows = this.castShadows;
    return l;
  }
}
