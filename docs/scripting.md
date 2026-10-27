# Scripting API

Messier composes games Unity-style: a scene is a hierarchy of **GameObjects**, each with one **Transform** and any
number of **components**. Behaviour is added with **Behaviour** components (in the editor, TypeScript **Script**s).
Typed **signals** and **groups** come from Godot.

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

The demo project's `Carousel` and `LapFlash` scripts show a signal crossing between two objects.

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

## Scene

```ts
this.scene.query(Health);        // live components: enabled, on active objects; kept up to date
this.scene.getGroup('enemies');  // objects in a group
this.scene.findByName('Player');
this.scene.activeCamera();
```

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
