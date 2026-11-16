import type { AudioClip } from './audioClip';
import type { Camera } from './camera';
import type { Component } from './component';
import type { Scene } from './scene';
import type { Vec3 } from './math';

/** Options for `audio.play()`. */
export interface PlayOptions {
  /** 0 and up (1 = as recorded). */
  volume?: number;
  /** Playback speed: 2 is an octave up and twice as fast. */
  pitch?: number;
  loop?: boolean;
  /** World position: the sound is panned and fades with distance from the listener (and follows `owner`, if given). Omit for a 2D sound. */
  position?: Readonly<Vec3>;
  /** Positional sounds: full volume up to this distance... */
  minDistance?: number;
  /** ...fading to silence at this one. */
  maxDistance?: number;
  /**
   * The component the sound belongs to (an AudioSource). A positional sound follows its object, and the sound stops
   * when the component stops being live in the active, running scene (disabled, destroyed, or its scene unloaded).
   */
  owner?: Component;
}

/** Most sounds playing at once; another one-shot replaces the oldest. */
const MAX_VOICES = 32;

/** One playing sound. */
export class AudioVoice {
  /** Set when the sound finished or was stopped. */
  ended = false;
  readonly owner: Component | null;
  readonly loop: boolean;
  readonly startedAt: number;
  readonly _node: AudioBufferSourceNode;
  readonly _gain: GainNode;
  readonly _panner: PannerNode | null;

  constructor(node: AudioBufferSourceNode, gain: GainNode, panner: PannerNode | null, owner: Component | null, loop: boolean, startedAt: number) {
    this._node = node;
    this._gain = gain;
    this._panner = panner;
    this.owner = owner;
    this.loop = loop;
    this.startedAt = startedAt;
  }

  get playing(): boolean {
    return !this.ended;
  }

  set volume(v: number) {
    if (this._gain.gain.value !== v) this._gain.gain.value = Math.max(0, v);
  }

  set pitch(v: number) {
    if (this._node.playbackRate.value !== v) this._node.playbackRate.value = Math.max(0.01, v);
  }

  stop(): void {
    if (this.ended) return;
    this.ended = true;
    try {
      this._node.stop();
    } catch {
      // Already stopped.
    }
    this._node.disconnect();
    this._panner?.disconnect();
    this._gain.disconnect();
  }

  _setPosition(p: Readonly<Vec3>): void {
    const pn = this._panner;
    if (!pn) return;
    if (pn.positionX) {
      pn.positionX.value = p[0];
      pn.positionY.value = p[1];
      pn.positionZ.value = p[2];
    } else pn.setPosition(p[0], p[1], p[2]);
  }
}

type AudioContextClass = new (options?: AudioContextOptions) => AudioContext;

/**
 * Sound output, through the Web Audio API. Browsers only let a page start audio after the user interacted with it,
 * and the engine never listens to the page itself: the host (the editor, or a built game) calls `resume()` from
 * its key and pointer handlers. Until then, and wherever there is no Web Audio (Node), `play()` does nothing and
 * returns null. `Engine.step` calls `update()` every frame to move the listener with the camera being rendered.
 */
export class AudioSystem {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private readonly voices: AudioVoice[] = [];
  private volume = 1;
  private mute = false;

  /** Whether this environment has Web Audio at all. */
  get supported(): boolean {
    return contextClass() !== null;
  }

  /** True once the context exists and runs (after the first user interaction): sounds are audible. */
  get ready(): boolean {
    return this.ctx?.state === 'running';
  }

  /** The Web Audio context, once `resume()` created it. */
  get context(): AudioContext | null {
    return this.ctx;
  }

  get masterVolume(): number {
    return this.volume;
  }
  set masterVolume(v: number) {
    this.volume = Math.max(0, v);
    this.applyVolume();
  }

  get muted(): boolean {
    return this.mute;
  }
  set muted(v: boolean) {
    this.mute = v;
    this.applyVolume();
  }

  /** Sounds playing now. */
  get activeVoices(): number {
    return this.voices.length;
  }

  /** Creates or resumes the audio context. Call it from a user gesture (key or pointer event). */
  resume(): void {
    const Ctx = contextClass();
    if (!Ctx) return;
    if (!this.ctx) {
      const ctx = new Ctx({ latencyHint: 'interactive' });
      const compressor = ctx.createDynamicsCompressor();
      compressor.connect(ctx.destination);
      this.master = ctx.createGain();
      this.master.connect(compressor);
      this.ctx = ctx;
      this.applyVolume();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  /** Decodes a sound file (wav, mp3, ogg…). Works before `resume()`; fails where there is no Web Audio. */
  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    const Offline = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
    // An offline context decodes without the autoplay rules of a live one.
    const ctx = this.ctx ?? (Offline ? new Offline(1, 1, 48000) : null);
    if (!ctx) throw new Error('Audio decoding is not available here');
    return ctx.decodeAudioData(data.slice(0));
  }

  /** Plays a clip once (or looping). Returns null when audio isn't running yet or the clip is empty. */
  play(clip: AudioClip, options: PlayOptions = {}): AudioVoice | null {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.master || clip.duration === 0) return null;
    if (this.voices.length >= MAX_VOICES) {
      const oldest = this.voices.find((v) => !v.loop);
      if (!oldest) return null;
      oldest.stop();
      this.prune();
    }
    if (!clip._buffer) {
      const buf = ctx.createBuffer(clip.channels.length, clip.channels[0].length, clip.sampleRate);
      clip.channels.forEach((data, c) => buf.copyToChannel(data, c));
      clip._buffer = buf;
    }
    const node = ctx.createBufferSource();
    node.buffer = clip._buffer;
    node.loop = !!options.loop;
    node.playbackRate.value = Math.max(0.01, options.pitch ?? 1);
    const gain = ctx.createGain();
    gain.gain.value = Math.max(0, options.volume ?? 1);
    let panner: PannerNode | null = null;
    const position = options.position ?? null;
    if (position) {
      panner = ctx.createPanner();
      panner.panningModel = 'HRTF';
      // Linear: silent at maxDistance, which is easier to reason about in a game than the inverse law's long tail.
      panner.distanceModel = 'linear';
      panner.refDistance = Math.max(0.01, options.minDistance ?? 2);
      panner.maxDistance = Math.max(panner.refDistance + 0.01, options.maxDistance ?? 40);
      panner.rolloffFactor = 1;
      node.connect(panner).connect(gain);
    } else node.connect(gain);
    gain.connect(this.master);
    const voice = new AudioVoice(node, gain, panner, options.owner ?? null, node.loop, ctx.currentTime);
    if (position) voice._setPosition(position);
    node.onended = () => {
      voice.stop();
      this.prune();
    };
    node.start();
    this.voices.push(voice);
    return voice;
  }

  /** Stops every sound. */
  stopAll(): void {
    for (const v of this.voices) v.stop();
    this.voices.length = 0;
  }

  /**
   * Per frame: places the listener at `view`, moves positional sounds with their owners, and stops sounds whose owner
   * left the running `scene`.
   */
  update(scene: Scene, view: Camera): void {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const v of this.voices) {
      const o = v.owner;
      if (!o) continue;
      if (o._registeredIn !== scene || !scene.running) v.stop();
      else if (v._panner) v._setPosition(o.transform.worldPosition);
    }
    this.prune();
    const l = ctx.listener;
    const p = view.position;
    const f = view.forward();
    const u = view.up;
    if (l.positionX) {
      l.positionX.value = p[0];
      l.positionY.value = p[1];
      l.positionZ.value = p[2];
      l.forwardX.value = f[0];
      l.forwardY.value = f[1];
      l.forwardZ.value = f[2];
      l.upX.value = u[0];
      l.upY.value = u[1];
      l.upZ.value = u[2];
    } else {
      l.setPosition(p[0], p[1], p[2]);
      l.setOrientation(f[0], f[1], f[2], u[0], u[1], u[2]);
    }
  }

  private prune(): void {
    let j = 0;
    for (const v of this.voices) if (!v.ended) this.voices[j++] = v;
    this.voices.length = j;
  }

  private applyVolume(): void {
    if (this.master) this.master.gain.value = this.mute ? 0 : this.volume;
  }
}

function contextClass(): AudioContextClass | null {
  const g = globalThis as { AudioContext?: AudioContextClass; webkitAudioContext?: AudioContextClass };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

/** The engine's sound output. */
export const audio = new AudioSystem();
