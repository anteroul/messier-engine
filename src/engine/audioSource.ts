import { audio, type AudioVoice } from './audio';
import type { AudioClip } from './audioClip';
import { Component } from './component';
import type { Scene } from './scene';

/** Fields saved with a scene (the clip is saved as a ref). Keep in sync with clone(). */
export const AUDIO_SOURCE_FIELDS = ['volume', 'pitch', 'loop', 'playOnStart', 'spatial', 'minDistance', 'maxDistance'] as const;

type AudioSourceInit = Partial<Pick<AudioSource, (typeof AUDIO_SOURCE_FIELDS)[number] | 'clip'>>;

/**
 * Plays a clip from its object. Sounds only play while the scene runs (Play in the editor, or a built game), and stop
 * when the source is disabled, its object is deactivated or destroyed, or another scene loads. A `spatial` source is
 * heard from where its object is, relative to the camera being rendered.
 */
export class AudioSource extends Component {
  clip: AudioClip | null = null;
  /** 0 and up. */
  volume = 1;
  /** Playback speed: 2 is an octave up. */
  pitch = 1;
  loop = false;
  /** Plays whenever the source becomes live in a running scene: when Play starts, or when its object is activated. */
  playOnStart = false;
  /** Positional: panned and fading with distance. Off: the same everywhere (music, UI sounds). */
  spatial = true;
  /** Spatial: full volume up to this distance, fading to silence at maxDistance. */
  minDistance = 2;
  maxDistance = 40;

  _voice: AudioVoice | null = null;
  _autoplayed = false;

  constructor(init: AudioSourceInit = {}) {
    super();
    Object.assign(this, init);
  }

  /** Whether the source's own sound (from play()) is playing. One-shots don't count. */
  get isPlaying(): boolean {
    return !!this._voice?.playing;
  }

  /** Plays the clip from the start, replacing what play() started before. */
  play(): void {
    this.stop();
    if (this.clip) this._voice = this._start(this.clip, 1, this.loop);
  }

  stop(): void {
    this._voice?.stop();
    this._voice = null;
  }

  /** Plays a clip (default: this source's) once over whatever is playing; several can overlap: shots, footsteps, impacts. */
  playOneShot(clip?: AudioClip | null, volumeScale = 1): void {
    const c = clip ?? this.clip;
    if (c) this._start(c, volumeScale, false);
  }

  _start(clip: AudioClip, volumeScale: number, loop: boolean): AudioVoice | null {
    if (!this._registeredIn?.running) return null;
    return audio.play(clip, {
      volume: this.volume * volumeScale,
      pitch: this.pitch,
      loop,
      owner: this,
      ...(this.spatial ? { position: this.transform.worldPosition, minDistance: this.minDistance, maxDistance: this.maxDistance } : {}),
    });
  }
}

let lastLive = new Set<AudioSource>();

/**
 * Per frame, for the active scene: starts `playOnStart` sources each time they become live (enabled, active, in the
 * running scene) once audio runs, so a looping sound that was due before the first user interaction still starts.
 * Also applies volume and pitch changes to playing sounds.
 */
export function updateAudioSources(scene: Scene): void {
  const live = new Set<AudioSource>(scene.running && audio.ready ? scene.query(AudioSource) : []);
  for (const s of lastLive) if (!live.has(s)) s._autoplayed = false;
  lastLive = live;
  for (const s of live) {
    if (s.playOnStart && !s._autoplayed) {
      s._autoplayed = true;
      s.play();
    }
    const v = s._voice;
    if (!v) continue;
    if (!v.playing) s._voice = null;
    else {
      v.volume = s.volume;
      v.pitch = s.pitch;
    }
  }
}
