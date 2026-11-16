import type { Texture } from './material';
import type { Vec3 } from './math';

/**
 * What a scene shows behind everything. `color`: the flat `Scene.background`. `gradient`: a sky from `top` through
 * `horizon` to `ground`, with a sun disc toward the scene's first directional light. `image`: an equirectangular
 * (2:1) panorama. A gradient or image sky also lights the scene: metals reflect it (blurrier the rougher they are),
 * and ambient light comes from it, scaled by `lighting`, instead of from `Scene.ambientColor` × `ambientIntensity`.
 */
export type SkyMode = 'color' | 'gradient' | 'image';
export const SKY_MODES: readonly SkyMode[] = ['color', 'gradient', 'image'];

/** Fields saved with a scene (the texture is saved as a ref). Keep in sync with copyFrom(). */
export const SKY_FIELDS = ['mode', 'top', 'horizon', 'ground', 'sunSize', 'sunGlow', 'intensity', 'rotation', 'lighting'] as const;

export class Sky {
  mode: SkyMode = 'color';
  /**
   * Gradient colors, linear RGB (like light colors: values above 1 are fine, exposure applies). Daylight sky is much
   * dimmer than the sun: these suit a directional light of intensity 3.
   */
  top: Vec3 = [0.045, 0.11, 0.34];
  horizon: Vec3 = [0.34, 0.4, 0.52];
  ground: Vec3 = [0.05, 0.047, 0.043];
  /** Gradient: angular diameter of the sun disc in degrees (0 hides it). */
  sunSize = 1.2;
  /** Gradient: strength of the haze around the sun. */
  sunGlow = 0.35;
  /** Image: equirectangular panorama (2:1, +Y up), or null. */
  texture: Texture | null = null;
  /** Image: brightness multiplier. */
  intensity = 1;
  /** Image: turn around the vertical axis, degrees. */
  rotation = 0;
  /** Gradient and image: how strongly the sky lights the scene (reflections and ambient light). */
  lighting = 1;

  copyFrom(o: Sky): this {
    this.mode = o.mode;
    this.top = [...o.top];
    this.horizon = [...o.horizon];
    this.ground = [...o.ground];
    this.sunSize = o.sunSize;
    this.sunGlow = o.sunGlow;
    this.texture = o.texture;
    this.intensity = o.intensity;
    this.rotation = o.rotation;
    this.lighting = o.lighting;
    return this;
  }

  /** The mode the renderer draws: an image sky without an image falls back to the gradient. */
  get effectiveMode(): SkyMode {
    return this.mode === 'image' && !this.texture ? 'gradient' : this.mode;
  }
}
