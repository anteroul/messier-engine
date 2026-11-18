# Scripting API

Messier composes games Unity-style: a scene is a hierarchy of **GameObjects**, each with one **Transform** and any
number of **components**. Behaviour is added with **Behaviour** components (in the editor, TypeScript **Script**s).
Typed **signals** and **groups** come from Godot.

In a project folder each script is a file, `scripts/<Name>.ts`. Write it in the editor's Scripts tab or in any other
editor (VS Code): the Messier editor picks up changes to the file within a second and hot-reloads them.

## A minimal script

Scripts are written in the editor's Scripts tab and import the engine from `'messier'`:

```ts
import { Script, Signal } from 'messier';

/** Spins the object and announces each full turn. */
export default class Spinner extends Script {
  speed = 90; // degrees per second; public number fields are inspector parameters
  readonly lap = new Signal<[laps: number]>();
  private angle = 0; // private, protected and _-prefixed fields stay hidden
  private laps = 0;

  start(): void {
    // With `this` as the owner, the listener is dropped when this script is destroyed.
    this.lap.connect((n) => console.log(`${this.object.name} finished lap ${n}`), this);
  }

  update(dt: number): void {
    this.angle += this.speed * dt;
    this.transform.setEulerDeg(0, this.angle, 0);
    if (this.angle >= (this.laps + 1) * 360) this.lap.emit(++this.laps);
  }
}
```

The demo project's `Carousel` and `LapFlash` scripts show a signal crossing between two objects. Its **Gem Rush**
scene is a whole game made of scripts (`GameManager`, `PlayerBall`, `GemSpawner`, `Gem`, `Sentinel`…): a bigger
example of input, physics, signals, groups and spawning from templates. The **Neon Run**, **Topple** and **Starfall** scenes each
run on one larger script that hands out pooled objects, and **Arcade** switches scenes with `sceneManager`.

Scripts can't import each other. To call another script, find it by name and describe the part you use:

```ts
interface GameApi { addPoints(n: number): void; won: Signal<[]> }
const game = this.scene.query(Script).find((s) => s.typeName === 'GameManager') as unknown as GameApi | undefined;
game?.won.connect(() => (this.enabled = false), this);
```

## Lifecycle

Hooks run only while the scene runs (Play). Override the ones you need:

| Hook | When |
| --- | --- |
| `awake()` | Once, when the object is first active in a running scene (also if the behaviour is disabled) |
| `onEnable()` / `onDisable()` | Each time the behaviour becomes live / stops being live (enabled and object active in hierarchy) |
| `start()` | Once, right before the first `fixedUpdate` or `update`, only while enabled |
| `fixedUpdate(fixedDt)` | Every fixed step (60 Hz by default), before physics |
| `update(dt, time)` | Every frame |
| `lateUpdate(dt)` | Every frame, after all updates |
| `onDestroy()` | Once, when the behaviour or its object is destroyed, or Play stops |

Each frame: fixed steps → `update` → `lateUpdate` → transform sync → render → deferred destroys.

- A behaviour is only dispatched for the per-frame hooks its class overrides, so an empty one costs nothing.
- Adding components or objects inside a hook is safe: they wake at once and first update next frame.
- `GameObject.destroy(objOrComponent)` is deferred: the target gets no more callbacks from that moment, and
  `onDisable` → `onDestroy` run at the end of the frame, when it's detached.
- A hook that throws pauses that behaviour. Script errors show in the Scripts tab, mapped to the source line.
- Play runs a copy of the scene. Stop discards it, so everything a script did is undone.

## GameObjects and components

```ts
const obj = new GameObject('Enemy');
const hp = obj.addComponent(Health, { max: 50 }); // init is applied before awake
obj.getComponent(Health);               // first instance (subclasses count), or null
obj.getComponents(Behaviour);           // all of them
obj.getComponentInChildren(Light);      // self, then descendants (skips inactive unless asked)
obj.getComponentInParent(RigidBody);    // self, then ancestors
obj.removeComponent(hp);                // destroys it
obj.find('Body/Weapon');                // child path by names
obj.setActive(false);                   // also: activeSelf, activeInHierarchy
obj.addToGroup('enemies');              // groups (tags)
GameObject.instantiate(prefab, parent?); // deep copy into the scene
GameObject.destroy(obj);
```

Built-in components: `MeshRenderer` (mesh, material, castShadows), `Light`, `CameraComponent`, `RigidBody`.
`obj.mesh`, `obj.material`, `obj.light`, `obj.camera` and `obj.rigidBody` are shortcuts for them.
Objects also have `childAdded`, `childRemoved` and `destroyed` signals.

A component class only needs to extend `Component` (data) or `Behaviour` (hooks). `clone()` copies public fields
for `instantiate`; override it for deeper copies. Signal fields get a fresh signal in each copy.

## 2D shapes and text

`Shape2D` and `Text2D` are components. With `space: 'world'` they lie on the object's local XY plane (facing +Z,
sizes in meters); with `space: 'screen'` they're a HUD, positioned in pixels from `anchor` (+Y up). Colors are
display-space RGBA (0…1), like CSS colors.

```ts
import { Script, Text2D } from 'messier';

export default class Score extends Script {
  private label: Text2D | null = null;
  private points = 0;

  start(): void {
    this.label = this.object.getComponent(Text2D);
  }

  addPoint(): void {
    this.points++;
    if (this.label) this.label.text = `Score ${this.points}`;
  }
}
```

| `Shape2D` | |
| --- | --- |
| `shape` | `'rectangle'` (with `cornerRadius`), `'ellipse'`, `'polygon'` (`sides`) or `'path'` (`points`: flat x, y list, `closed`) |
| `width` / `height` | size in local units |
| `filled`, `fillColor`, `strokeWidth`, `strokeColor` | fill and outline (`strokeWidth` 0 = none) |

| `Text2D` | |
| --- | --- |
| `text` | the string (`\n` breaks lines) |
| `fontSize`, `fontFamily`, `bold`, `color` | em size in local units, any CSS font family |
| `align` / `verticalAlign` | which side of the text is at the object's origin |
| `lineHeight`, `maxWidth` | line spacing (× size); wrap width (0 = none) |
| `outlineWidth`, `outlineColor` | outline around the glyphs |

Both have `space`, `anchor` (screen space: `'top-left'`, `'top'`, … `'center'` … `'bottom-right'`) and `order` (higher
draws on top).

For throwaway drawing, `draw2d` draws over the frame in pixels from the top-left corner (y down). It only lasts one
frame, so call it from `update` every frame:

```ts
draw2d.rect(10, 10, 200, 24, { fill: '#0008', stroke: '#fff', strokeWidth: 1 }, 6); // last arg: corner radius
draw2d.rect(12, 12, 196 * health, 20, { fill: [0.9, 0.2, 0.2] });
draw2d.circle(x, y, 8, { fill: '#ffcc33' });
draw2d.line(x1, y1, x2, y2, '#f00', 2);
draw2d.polygon([[0, 0], [20, 10], [0, 20]], { fill: '#fff' });
draw2d.text('Paused', draw2d.width / 2, 40, { size: 32, align: 'center', bold: true, outlineWidth: 2 });
draw2d.measureText('Paused', { size: 32 }); // { width, height }
```

## Scene

```ts
this.scene.query(Health);        // live components: enabled, on active objects; kept up to date
this.scene.getGroup('enemies');  // objects in a group
this.scene.findByName('Player');
this.scene.activeCamera();
const enemy = this.scene.instantiate('Enemy'); // an instance of assets/Enemy.prefab (or null), at the top level
this.scene.instantiate('Effects/Spark', this.object); // by path under assets/, as a child of this object
this.scene.sky.mode = 'gradient';   // or 'color' (scene.background) or 'image' (sky.texture, a 2:1 panorama)
this.scene.sky.top = [0.3, 0.05, 0.2]; // sky colors are linear; ambient light and reflections follow the sky
```

`instantiate()` takes a prefab's name (`'Enemy'` for `assets/Enemy.prefab`) or its path under `assets/`, and places
the instance where the prefab's root was when it was made; move it afterwards. A built game ships every prefab of
the project, used in a scene or not, so scripts can spawn any of them.

## Sound

An `AudioSource` component plays a clip from its object. Clips are imported sound files (pick one in the inspector)
or sound effects from the built-in synthesizer, which needs no files. Sounds play only while the scene runs, and stop
when their source is disabled or destroyed or another scene loads.

```ts
import { AudioClip, AudioSource, SFX_PRESETS, Script, audio, input } from 'messier';

export default class Blaster extends Script {
  private source: AudioSource | null = null;
  private boom = AudioClip.synth({ ...SFX_PRESETS.explosion, frequency: 900 }); // cached: same parameters, same clip

  start(): void {
    this.source = this.object.getComponent(AudioSource); // the clip set in the inspector
  }

  update(): void {
    if (input.pressed('Space')) this.source?.playOneShot(); // overlapping one-shots
    if (input.pressed('KeyB')) audio.play(this.boom, { position: this.transform.worldPosition, volume: 0.8 });
  }
}
```

- `source.play()` / `stop()` / `isPlaying` for its own sound (music, an engine loop with `loop` on);
  `source.playOneShot(clip?, volumeScale?)` for overlapping effects. `volume` and `pitch` can change while it plays.
- `audio.play(clip, { volume, pitch, loop, position, minDistance, maxDistance })` plays without a source and returns
  an `AudioVoice` (`stop()`, `playing`). Use it for a sound that must outlive its object (a pickup that destroys
  itself) or to play a source's clip somewhere else. Pass `position` for a positional sound.
- Presets: `coin`, `laser`, `explosion`, `hit`, `jump`, `powerup`, `blip`, `select`, `thump`, `hum` (a seamless loop).
  `SfxParams` has the knobs (wave, frequency, slide, envelope, vibrato, arpeggio, low-pass…); `mutateSfx(params, seed)`
  makes variations.
- The listener is the camera the picture is rendered from. `audio.muted` and `audio.masterVolume` mix everything.

## Switching scenes

A game's scenes are the ones ticked in **☰ → Build…**, in that order. `sceneManager` loads them by name or build
index, in a built game and during Play in the editor:

```ts
import { Script, input, sceneManager } from 'messier';

export default class LevelExit extends Script {
  update(): void {
    if (input.pressed('KeyR')) void sceneManager.loadScene(sceneManager.activeSceneIndex); // restart
    if (this.object.transform.position[1] < -10) void sceneManager.loadScene('Game Over');
  }
}
```

| Member | |
| --- | --- |
| `loadScene(nameOrIndex)` | Starts a fresh copy of that scene. Resolves to the new `Scene`, or `null` (with a warning) |
| `sceneCount` / `sceneName(i)` | The build's scenes |
| `activeSceneIndex` / `activeSceneName` | The scene loadScene() last loaded (-1 / null when Play started in one that isn't in the build) |
| `isLoading` | A load is in progress |
| `sceneLoaded` | Signal `(scene, index)` after a load |

The switch happens after the current frame at the earliest (imported models may have to load first), and the last
call wins. The old scene stops (`onDisable` → `onDestroy`) and is thrown away, so keep game state that should survive
in module-level variables of a script or pass it some other way. Loading the scene that's running restarts it.

## Transform

`position`, `rotation` (quaternion `[x, y, z, w]`) and `scale` are local. Assign them or edit in place
(`transform.position[1] = 2`); world matrices are cached and recomputed only when something above changed.

| Member | |
| --- | --- |
| `worldPosition` / `worldRotation` | get and set in world space |
| `setParent(parent, keepWorldTransform = true)` | reparent (`parent` is a Transform or null) |
| `lookAt(target, up?)` | point local −Z at a point or another transform |
| `forward` / `right` / `up` | world directions of −Z / +X / +Y |
| `transformPoint` / `inverseTransformPoint` | local ↔ world points |
| `transformDirection` / `inverseTransformDirection` | local ↔ world directions (rotation only) |
| `setEulerDeg(x, y, z)` / `getEulerDeg()` | degrees, XYZ order |

Hot code can avoid allocations with `getWorldPosition(out)`, `getWorldRotation(out)` and `getAxis(axis, sign, out)`.

## Signals

```ts
const hit = new Signal<[damage: number, from: GameObject]>();
const off = hit.connect((damage, from) => …, this); // owner: auto-disconnects when `this` is destroyed
hit.once((damage) => …);
hit.emit(5, attacker);
const [damage] = await hit.next();
off(); // or hit.disconnect(fn)
```

## Time

`Time.deltaTime`, `Time.time`, `Time.frameCount`, `Time.fixedDeltaTime` (or `Time.fixedRate` in Hz),
`Time.timeScale` (0 pauses), `Time.maxSubsteps` and `Time.alpha` (fraction between fixed steps).

## From code (outside the editor)

```ts
const engine = await Engine.create(canvas);
engine.scene.add(obj);
engine.setPlaying(true); // run behaviours and physics in the active scene
engine.start();
engine.setActiveScene(otherScene); // switch scenes; the old one stops running
```

Write engine-side behaviours as `Behaviour` subclasses. In scripts, `Script` adds `this.object` (the GameObject),
`this.scene` and `this.find(name)`.
