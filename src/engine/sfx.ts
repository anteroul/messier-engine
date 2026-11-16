// A small sound-effect synthesizer in the spirit of sfxr: one oscillator with a pitch slide, vibrato, an arpeggio
// jump and an envelope, through a low-pass filter. Rendering is plain TypeScript with a seeded noise generator, so the
// same parameters always give the same samples (a saved `{ sfx }` clip ref rebuilds it exactly) and it runs under
// Node. Games get blips, lasers and explosions without any sound files.

export type SfxWave = 'square' | 'saw' | 'sine' | 'triangle' | 'noise';
export const SFX_WAVES: readonly SfxWave[] = ['square', 'saw', 'sine', 'triangle', 'noise'];

export interface SfxParams {
  wave: SfxWave;
  /** Start pitch in Hz (for noise: how fast the noise changes). */
  frequency: number;
  /** Pitch change in octaves per second (negative falls). */
  slide: number;
  /** Seconds: rise to full volume, hold, then fade to silence. The clip is as long as the three together. */
  attack: number;
  sustain: number;
  decay: number;
  /** 0–1: extra volume at the start of the sustain, falling off over it. */
  punch: number;
  /** Vibrato depth (fraction of the pitch) and speed (Hz). */
  vibratoDepth: number;
  vibratoSpeed: number;
  /** Square wave: fraction of each cycle that is high (0.5 is a plain square), and its change per second. */
  duty: number;
  dutySweep: number;
  /** Pitch multiplier applied after `arpeggioTime` seconds (1 or a time of 0: none). Coins and power-ups use it. */
  arpeggio: number;
  arpeggioTime: number;
  /** Restarts the pitch sweep every this many seconds (0: never). */
  repeat: number;
  /** Low-pass cutoff in Hz (0: off). */
  lowpass: number;
  /** 0–1. */
  volume: number;
  /** Noise seed. */
  seed: number;
}

/** Order of the fields in the packed form (`packSfx`) a clip ref stores. Append new fields at the end. */
const SFX_KEYS = [
  'wave', 'frequency', 'slide', 'attack', 'sustain', 'decay', 'punch', 'vibratoDepth', 'vibratoSpeed', 'duty', 'dutySweep',
  'arpeggio', 'arpeggioTime', 'repeat', 'lowpass', 'volume', 'seed',
] as const satisfies readonly (keyof SfxParams)[];

export const SFX_DEFAULTS: Readonly<SfxParams> = {
  wave: 'square', frequency: 440, slide: 0, attack: 0, sustain: 0.1, decay: 0.2, punch: 0, vibratoDepth: 0, vibratoSpeed: 0,
  duty: 0.5, dutySweep: 0, arpeggio: 1, arpeggioTime: 0, repeat: 0, lowpass: 0, volume: 0.5, seed: 1,
};

const preset = (p: Partial<SfxParams>): Readonly<SfxParams> => Object.freeze({ ...SFX_DEFAULTS, ...p });

/** Ready-made effects. Use one as is, or spread it and change a field: `{ ...SFX_PRESETS.laser, frequency: 900 }`. */
export const SFX_PRESETS = {
  coin: preset({ wave: 'square', frequency: 988, sustain: 0.05, punch: 0.5, decay: 0.28, arpeggio: 1.335, arpeggioTime: 0.07, volume: 0.35 }),
  laser: preset({ wave: 'saw', frequency: 1500, slide: -5, sustain: 0.05, decay: 0.16, lowpass: 7000, volume: 0.3 }),
  explosion: preset({ wave: 'noise', frequency: 1800, slide: -1.6, sustain: 0.12, punch: 0.7, decay: 0.75, lowpass: 2600, volume: 0.8 }),
  hit: preset({ wave: 'noise', frequency: 2400, slide: -3.5, sustain: 0.02, punch: 0.4, decay: 0.14, lowpass: 5000, volume: 0.6 }),
  jump: preset({ wave: 'square', frequency: 280, slide: 2.4, sustain: 0.07, decay: 0.16, duty: 0.35, lowpass: 5000, volume: 0.3 }),
  powerup: preset({ wave: 'square', frequency: 330, slide: 1.6, sustain: 0.18, decay: 0.3, vibratoDepth: 0.05, vibratoSpeed: 14, repeat: 0.11, duty: 0.4, volume: 0.28 }),
  blip: preset({ wave: 'square', frequency: 880, sustain: 0.035, decay: 0.07, volume: 0.25 }),
  select: preset({ wave: 'sine', frequency: 660, sustain: 0.05, decay: 0.14, arpeggio: 1.5, arpeggioTime: 0.05, volume: 0.45 }),
  thump: preset({ wave: 'sine', frequency: 160, slide: -2.5, sustain: 0.04, punch: 0.8, decay: 0.3, volume: 0.9 }),
  /** A seamless one-second loop: an engine or machine drone. */
  hum: preset({ wave: 'saw', frequency: 55, sustain: 1, decay: 0, vibratoDepth: 0.01, vibratoSpeed: 5, lowpass: 420, volume: 0.35 }),
} satisfies Record<string, Readonly<SfxParams>>;

export type SfxPresetName = keyof typeof SFX_PRESETS;

/** The parameters as the number list a clip ref stores. */
export function packSfx(p: Readonly<SfxParams>): number[] {
  return SFX_KEYS.map((k) => (k === 'wave' ? Math.max(0, SFX_WAVES.indexOf(p.wave)) : (p[k] as number)));
}

/** Reads a packed list; missing or invalid entries keep their defaults. */
export function unpackSfx(values: readonly number[]): SfxParams {
  const p: SfxParams = { ...SFX_DEFAULTS };
  const out = p as unknown as Record<string, unknown>;
  SFX_KEYS.forEach((k, i) => {
    const v = values[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) return;
    out[k] = k === 'wave' ? (SFX_WAVES[Math.round(v)] ?? SFX_DEFAULTS.wave) : v;
  });
  return p;
}

/** Longest clip rendered, in seconds. */
const MAX_LENGTH = 10;

/** Renders mono samples at `sampleRate`. */
export function renderSfx(params: Readonly<SfxParams>, sampleRate = 44100): Float32Array<ArrayBuffer> {
  const p = params;
  const attack = clamp(p.attack, 0, MAX_LENGTH);
  const sustain = clamp(p.sustain, 0, MAX_LENGTH);
  const decay = clamp(p.decay, 0, MAX_LENGTH);
  const length = Math.min(MAX_LENGTH, attack + sustain + decay);
  const n = Math.max(1, Math.round(length * sampleRate));
  const out = new Float32Array(n);
  const random = rng(p.seed);
  const cutoff = p.lowpass > 0 ? 1 - Math.exp((-2 * Math.PI * Math.min(p.lowpass, sampleRate / 2)) / sampleRate) : 1;
  const volume = clamp(p.volume, 0, 1);
  let phase = 0;
  let noise = random() * 2 - 1;
  let filtered = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const sweepT = p.repeat > 0 ? t % p.repeat : t;
    let freq = p.frequency * 2 ** (p.slide * sweepT);
    if (p.arpeggioTime > 0 && sweepT >= p.arpeggioTime) freq *= p.arpeggio;
    if (p.vibratoDepth) freq *= 1 + p.vibratoDepth * Math.sin(2 * Math.PI * p.vibratoSpeed * t);
    freq = clamp(freq, 10, sampleRate / 2);
    phase += freq / sampleRate;
    if (phase >= 1) {
      phase -= Math.floor(phase);
      noise = random() * 2 - 1;
    }
    let s: number;
    switch (p.wave) {
      case 'square':
        s = phase < clamp(p.duty + p.dutySweep * t, 0.05, 0.95) ? 0.6 : -0.6;
        break;
      case 'saw':
        s = 2 * phase - 1;
        break;
      case 'sine':
        s = Math.sin(2 * Math.PI * phase);
        break;
      case 'triangle':
        s = 1 - 4 * Math.abs(phase - 0.5);
        break;
      default:
        s = noise;
    }
    filtered += cutoff * (s - filtered);
    let env: number;
    if (t < attack) env = t / attack;
    else if (t < attack + sustain) env = 1 + p.punch * (1 - (t - attack) / sustain);
    else env = decay > 0 ? Math.max(0, 1 - (t - attack - sustain) / decay) : 0;
    out[i] = clamp(filtered * env * volume, -1, 1);
  }
  return out;
}

/** A variation of `params`: every number nudged by up to ±`amount` (a fraction), deterministic for a seed. */
export function mutateSfx(params: Readonly<SfxParams>, seed: number, amount = 0.15): SfxParams {
  const random = rng(seed);
  const nudge = (v: number) => v * (1 + (random() * 2 - 1) * amount);
  return {
    ...params,
    frequency: nudge(params.frequency),
    slide: nudge(params.slide),
    attack: nudge(params.attack),
    sustain: nudge(params.sustain),
    decay: nudge(params.decay),
    punch: clamp(nudge(params.punch), 0, 1),
    vibratoDepth: nudge(params.vibratoDepth),
    vibratoSpeed: nudge(params.vibratoSpeed),
    duty: clamp(nudge(params.duty), 0.05, 0.95),
    lowpass: nudge(params.lowpass),
    seed: Math.floor(random() * 1e6) + 1,
  };
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function rng(seed: number): () => number {
  let s = Math.floor(Math.abs(seed)) % 2147483646 || 1;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}
