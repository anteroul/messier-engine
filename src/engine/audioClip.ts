import { packSfx, renderSfx, unpackSfx, type SfxParams } from './sfx';

/**
 * Where a clip comes from, so a saved scene can rebuild it: the sound file of an imported project asset, or the
 * synthesizer parameters (`packSfx`) of a generated effect.
 */
export type ClipRef = { asset: string; index: number } | { sfx: number[] };

const SYNTH_RATE = 44100;
const SYNTH_CACHE_SIZE = 256;
const synthCache = new Map<string, AudioClip>();

/** A sound: sample data (one or two channels) at a sample rate. Clips are immutable, so objects share them freely. */
export class AudioClip {
  /** Source of the clip, or null when it was made at runtime from raw samples and can't be saved. */
  ref: ClipRef | null = null;
  /** The Web Audio buffer, created on first play. */
  _buffer: AudioBuffer | null = null;

  readonly name: string;
  readonly channels: readonly Float32Array<ArrayBuffer>[];
  readonly sampleRate: number;

  constructor(name: string, channels: Float32Array<ArrayBuffer>[], sampleRate: number) {
    if (channels.length === 0) throw new Error('An audio clip needs at least one channel');
    this.name = name;
    this.channels = channels;
    this.sampleRate = sampleRate;
  }

  /** Length in seconds. */
  get duration(): number {
    return this.channels[0].length / this.sampleRate;
  }

  /**
   * A synthesized sound effect (see `SFX_PRESETS`). The same parameters give the same clip instance, so calling this
   * every time a sound plays is cheap.
   */
  static synth(params: Readonly<SfxParams> | readonly number[], name = 'Sound'): AudioClip {
    const packed = isPacked(params) ? unpackSfx(params) : params;
    const values = packSfx(packed);
    const key = values.join(',');
    let clip = synthCache.get(key);
    if (!clip) {
      clip = new AudioClip(name, [renderSfx(packed, SYNTH_RATE)], SYNTH_RATE);
      clip.ref = { sfx: values };
      if (synthCache.size >= SYNTH_CACHE_SIZE) synthCache.delete(synthCache.keys().next().value!);
      synthCache.set(key, clip);
    }
    return clip;
  }

  /** The synthesizer parameters of a clip made by `synth()`, or null for other clips. */
  get sfx(): SfxParams | null {
    return this.ref && 'sfx' in this.ref ? unpackSfx(this.ref.sfx) : null;
  }

  /** Copies a decoded Web Audio buffer. */
  static fromAudioBuffer(buffer: AudioBuffer, name: string): AudioClip {
    const channels: Float32Array<ArrayBuffer>[] = [];
    for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(new Float32Array(buffer.getChannelData(c)));
    const clip = new AudioClip(name, channels, buffer.sampleRate);
    clip._buffer = buffer;
    return clip;
  }
}

function isPacked(p: Readonly<SfxParams> | readonly number[]): p is readonly number[] {
  return Array.isArray(p);
}
