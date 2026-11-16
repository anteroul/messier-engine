import { FakeAudioContext } from './fakeAudio';
import { check, eq, near } from './harness';
import { GameObject, Scene } from '@root/src/engine/scene.ts';
import { Camera } from '@root/src/engine/camera.ts';
import { audio } from '@root/src/engine/audio.ts';
import { AudioClip } from '@root/src/engine/audioClip.ts';
import { AudioSource, updateAudioSources } from '@root/src/engine/audioSource.ts';
import { SFX_PRESETS, mutateSfx, packSfx, renderSfx, unpackSfx } from '@root/src/engine/sfx.ts';
import { applySceneData, collectAssetIds, serializeScene } from '@root/src/engine/serialize.ts';
import { Project, ProjectResources } from '@root/src/engine/project.ts';
import { ScriptAsset } from '@root/src/engine/scripting.ts';
import { readFileSync } from 'node:fs';

// The synthesizer, clip refs, and the AudioSource lifecycle against a fake Web Audio context.

// ---- synthesizer
{
  const a = renderSfx(SFX_PRESETS.laser);
  const b = renderSfx(SFX_PRESETS.laser);
  check('synth is deterministic', a.length === b.length && a.every((v, i) => v === b[i]));
  const len = SFX_PRESETS.laser.attack + SFX_PRESETS.laser.sustain + SFX_PRESETS.laser.decay;
  eq('synth length is attack + sustain + decay', a.length, Math.round(len * 44100));
  check('synth stays within [-1, 1]', a.every((v) => v >= -1 && v <= 1));
  check('synth is not silent', a.some((v) => Math.abs(v) > 0.05));
  const noise = renderSfx(SFX_PRESETS.explosion);
  const noise2 = renderSfx({ ...SFX_PRESETS.explosion, seed: 2 });
  check('noise depends on the seed', noise.some((v, i) => v !== noise2[i]));
  eq('pack/unpack round-trips', unpackSfx(packSfx(SFX_PRESETS.coin)), { ...SFX_PRESETS.coin });
  eq('unpack keeps defaults for missing values', unpackSfx([2]).wave, 'sine');
  const varied = mutateSfx(SFX_PRESETS.jump, 7);
  check('mutate changes the sound', varied.frequency !== SFX_PRESETS.jump.frequency);
  eq('mutate is deterministic', mutateSfx(SFX_PRESETS.jump, 7), varied);
  const clip = AudioClip.synth(SFX_PRESETS.coin, 'coin');
  check('synth clips are cached', AudioClip.synth(SFX_PRESETS.coin) === clip && AudioClip.synth(packSfx(SFX_PRESETS.coin)) === clip);
  eq('synth clip ref holds the parameters', clip.ref, { sfx: packSfx(SFX_PRESETS.coin) });
  eq('synth clip exposes its parameters', clip.sfx, { ...SFX_PRESETS.coin });
}

// ---- saving: synth refs rebuild, asset refs resolve through the project
{
  const scene = new Scene();
  const a = new GameObject('Blip');
  a.attachComponent(new AudioSource({ clip: AudioClip.synth(SFX_PRESETS.blip), volume: 0.5, loop: true, spatial: false }));
  const b = new GameObject('Music');
  const music = new AudioClip('music', [new Float32Array(100)], 8000);
  music.ref = { asset: 'song', index: 0 };
  b.attachComponent(new AudioSource({ clip: music }));
  const c = new GameObject('Runtime');
  c.attachComponent(new AudioSource({ clip: new AudioClip('raw', [new Float32Array(10)], 8000) }));
  scene.add(a);
  scene.add(b);
  scene.add(c);
  const warnings: string[] = [];
  const data = serializeScene(scene, warnings);
  eq('runtime clips warn', warnings, ['Runtime: sound "raw" was created at runtime and can\'t be saved']);
  eq('audio assets are collected', [...collectAssetIds(data.objects)], ['song']);
  const res = new ProjectResources(new Project());
  res.registerClip('song', music);
  const loaded = new Scene();
  const loadWarnings: string[] = [];
  applySceneData(loaded, JSON.parse(JSON.stringify(data)), res, loadWarnings);
  eq('loads without warnings', loadWarnings, []);
  const la = loaded.findByName('Blip')!.getComponent(AudioSource)!;
  check('synth clip rebuilt (same cached clip)', la.clip === a.getComponent(AudioSource)!.clip);
  eq('fields round-trip', [la.volume, la.loop, la.spatial], [0.5, true, false]);
  check('asset clip resolved', loaded.findByName('Music')!.getComponent(AudioSource)!.clip === music);
  eq('saved again identically', serializeScene(loaded).objects.slice(0, 2), data.objects.slice(0, 2));
}

// ---- playback lifecycle
{
  const view = new Camera();
  const frame = (scene: Scene) => {
    scene.updateMatrices();
    updateAudioSources(scene);
    audio.update(scene, view);
  };
  const scene = new Scene();
  const obj = new GameObject('Speaker');
  obj.transform.position = [3, 0, 0];
  const src = obj.attachComponent(new AudioSource({ clip: AudioClip.synth(SFX_PRESETS.hum), loop: true, playOnStart: true }));
  scene.add(obj);

  check('nothing plays before the first user gesture', audio.play(AudioClip.synth(SFX_PRESETS.blip)) === null);
  scene.setRunning(true);
  frame(scene);
  check('playOnStart waits for audio', !src.isPlaying);
  audio.resume();
  const ctx = FakeAudioContext.last!;
  check('resume creates a running context', audio.ready && ctx.state === 'running');
  frame(scene);
  check('playOnStart starts once audio runs', src.isPlaying && ctx.playing.length === 1);
  check('the loop is looping', ctx.playing[0].loop);
  near('spatial source is placed at its object', ctx.panners[0].position, [3, 0, 0]);
  obj.transform.position = [0, 0, -5];
  frame(scene);
  near('and follows it', ctx.panners[0].position, [0, 0, -5]);
  near('listener is at the view camera', [ctx.listener.positionX.value, ctx.listener.positionY.value, ctx.listener.positionZ.value], view.position);
  src.volume = 0.25;
  frame(scene);
  near('volume changes apply while playing', ctx.gains.at(-1)!.gain.value, 0.25);

  src.enabled = false;
  frame(scene);
  check('disabling stops the sound', !src.isPlaying && ctx.playing.length === 0);
  src.enabled = true;
  frame(scene);
  check('becoming live again replays playOnStart', src.isPlaying);

  src.playOneShot(AudioClip.synth(SFX_PRESETS.coin));
  src.playOneShot(AudioClip.synth(SFX_PRESETS.coin));
  eq('one-shots overlap', ctx.playing.length, 3);
  ctx.playing.at(-1)!.finish();
  eq('finished sounds are released', audio.activeVoices, 2);

  scene.setRunning(false);
  frame(scene);
  eq('a scene that stops running goes quiet', ctx.playing.length, 0);
  src.play();
  eq('sources only play while their scene runs', ctx.playing.length, 0);

  const other = new Scene();
  scene.setRunning(true);
  frame(scene);
  check('playing again', src.isPlaying);
  other.setRunning(true);
  frame(other);
  check('sounds of a scene that is no longer active stop', !src.isPlaying);
  other.setRunning(false);

  const flat = new GameObject('Flat');
  const f = flat.attachComponent(new AudioSource({ clip: AudioClip.synth(SFX_PRESETS.blip), spatial: false }));
  scene.add(flat);
  const panners = ctx.panners.length;
  f.play();
  eq('non-spatial sources have no panner', ctx.panners.length, panners);

  audio.stopAll();
  for (let i = 0; i < 40; i++) audio.play(AudioClip.synth(SFX_PRESETS.blip));
  eq('voices are capped', audio.activeVoices, 32);
  audio.stopAll();
  eq('stopAll stops everything', ctx.playing.length, 0);

  audio.muted = true;
  eq('mute silences the master gain', ctx.gains[0].gain.value, 0);
  audio.muted = false;
  audio.masterVolume = 0.5;
  eq('master volume', ctx.gains[0].gain.value, 0.5);
  scene.setRunning(false);
}

// ---- the sound example in docs/scripting.md compiles and plays
{
  const doc = readFileSync(`${process.env.PROJECT_ROOT}/docs/scripting.md`, 'utf8');
  const example = /```ts\r?\n(import [^\n]*\n\nexport default class Blaster[\s\S]*?)```/.exec(doc)?.[1] ?? '';
  const scene = new Scene();
  const asset = scene.scripts.add(new ScriptAsset('Blaster', example));
  check('docs sound example compiles', example.includes('class Blaster') && asset.compile() && asset.ctor !== null, JSON.stringify(asset.diagnostics));
}
