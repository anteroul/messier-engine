/**
 * How the main pass is antialiased. `msaa`: 4× multisampling (sharp, but only geometry edges). `taa`: temporal
 * antialiasing (one sample per pixel, jittered from frame to frame and blended with the previous frames: smooths
 * shading and texture shimmer too, slightly softer).
 */
export type Antialiasing = 'msaa' | 'taa';
export const ANTIALIASING_MODES: readonly Antialiasing[] = ['msaa', 'taa'];

/** Fields saved with a scene. Keep in sync with copyFrom(). */
export const POST_FIELDS = ['antialiasing', 'bloom', 'bloomThreshold', 'bloomScatter'] as const;

/** The scene's post-processing: what happens to the rendered image before it's shown. */
export class PostProcessing {
  antialiasing: Antialiasing = 'msaa';
  /** Bloom strength: light brighter than the threshold glows over its surroundings. 0 turns bloom off. */
  bloom = 0;
  /** Brightness (linear, after exposure) where bloom starts, with a soft knee below it. */
  bloomThreshold = 1;
  /** 0…1: how far the glow spreads (higher reaches farther, with a softer core). */
  bloomScatter = 0.7;

  copyFrom(o: PostProcessing): this {
    this.antialiasing = o.antialiasing;
    this.bloom = o.bloom;
    this.bloomThreshold = o.bloomThreshold;
    this.bloomScatter = o.bloomScatter;
    return this;
  }
}
