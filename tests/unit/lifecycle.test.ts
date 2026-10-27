import { check, eq } from './harness';
import { GameObject, Scene } from '@root/src/engine/scene.ts';
import { Behaviour } from '@root/src/engine/behaviours.ts';
import { Signal } from '@root/src/engine/signal.ts';

let log: string[] = [];
const take = () => {
  const out = log;
  log = [];
  return out;
};

/** Logs every hook as `name.hook`; `on` lets a test run code inside a hook. */
class Logger extends Behaviour {
  label = '?';
  on: Partial<Record<string, (self: Logger) => void>> = {};
  private _hit(hook: string): void {
    log.push(`${this.label}.${hook}`);
    this.on[hook]?.(this);
  }
  awake(): void {
    this._hit('awake');
  }
  onEnable(): void {
    this._hit('onEnable');
  }
  start(): void {
    this._hit('start');
  }
  update(): void {
    this._hit('update');
  }
  fixedUpdate(): void {
    this._hit('fixedUpdate');
  }
  lateUpdate(): void {
    this._hit('lateUpdate');
  }
  onDisable(): void {
    this._hit('onDisable');
  }
  onDestroy(): void {
    this._hit('onDestroy');
  }
}

/** Only update; no other hooks. */
class Counter extends Behaviour {
  n = 0;
  update(): void {
    this.n++;
  }
}
/** No per-frame hooks at all. */
class Idle extends Behaviour {}

const add = (o: GameObject, label: string, on: Logger['on'] = {}, enabled = true) => o.addComponent(Logger, { label, on, enabled });
/** One frame without fixed steps: update, lateUpdate, matrices, destroys. */
const frame = (s: Scene) => {
  s.updateBehaviours(1 / 60, 0);
  s.lateUpdate(1 / 60);
  s.updateMatrices();
  s.processDestroyed();
};

// ---- order: awake → onEnable → start → update → lateUpdate; nothing while not running
{
  const scene = new Scene();
  const o = scene.add(new GameObject('o'));
  add(o, 'a');
  frame(scene);
  eq('no hooks while the scene is not running', take(), []);
  scene.setRunning(true);
  eq('running wakes live behaviours (awake, onEnable)', take(), ['a.awake', 'a.onEnable']);
  frame(scene);
  eq('start right before the first update', take(), ['a.start', 'a.update', 'a.lateUpdate']);
  frame(scene);
  eq('start only once', take(), ['a.update', 'a.lateUpdate']);
  scene.fixedUpdate(1 / 60);
  eq('fixedUpdate dispatch', take(), ['a.fixedUpdate']);

  scene.setRunning(false);
  eq('stopping runs onDisable then onDestroy', take(), ['a.onDisable', 'a.onDestroy']);
  scene.setRunning(true);
  frame(scene);
  eq('running again starts over with awake', take(), ['a.awake', 'a.onEnable', 'a.start', 'a.update', 'a.lateUpdate']);
}

// ---- fixedUpdate before the first update also gets start first
{
  const scene = new Scene();
  scene.setRunning(true);
  add(scene.add(new GameObject()), 'f');
  take();
  scene.fixedUpdate(1 / 60);
  eq('start before the first fixedUpdate', take(), ['f.start', 'f.fixedUpdate']);
}

// ---- add / remove while running
{
  const scene = new Scene();
  scene.setRunning(true);
  const o = scene.add(new GameObject('o'));
  const b = add(o, 'b');
  eq('adding to an active object in a running scene wakes at once', take(), ['b.awake', 'b.onEnable']);
  o.removeComponent(b);
  check('removeComponent marks at once', b.isDestroyed && b.attached);
  frame(scene);
  eq('removed before it started: no start/update, then onDisable → onDestroy at end of frame', take(), ['b.onDisable', 'b.onDestroy']);
  check('…and it is detached', !b.attached && o.components.length === 0);
}

// ---- enable / disable and awake-while-disabled
{
  const scene = new Scene();
  scene.setRunning(true);
  const o = scene.add(new GameObject('o'));
  const d = add(o, 'd', {}, false);
  eq('awake runs even when added disabled, onEnable does not', take(), ['d.awake']);
  frame(scene);
  eq('disabled: no start or update', take(), []);
  d.enabled = true;
  frame(scene);
  eq('enabling: onEnable, then start before update', take(), ['d.onEnable', 'd.start', 'd.update', 'd.lateUpdate']);
  d.enabled = false;
  d.enabled = true;
  d.enabled = false;
  frame(scene);
  eq('every transition fires, no second start', take(), ['d.onDisable', 'd.onEnable', 'd.onDisable']);
}

// ---- nested activation
{
  const scene = new Scene();
  scene.setRunning(true);
  const parent = scene.add(new GameObject('p'));
  const child = parent.add(new GameObject('c'));
  add(parent, 'P');
  add(child, 'C');
  take();
  parent.setActive(false);
  eq('deactivating a parent disables the subtree', take(), ['P.onDisable', 'C.onDisable']);
  child.setActive(false);
  parent.setActive(true);
  eq('a child that is inactive itself stays disabled', take(), ['P.onEnable']);
  child.setActive(true);
  eq('…until it is activated', take(), ['C.onEnable']);

  const inactive = scene.add(new GameObject('i'));
  inactive.setActive(false);
  const kid = inactive.add(new GameObject('k'));
  add(kid, 'K');
  frame(scene);
  eq('awake waits until the object is active in the hierarchy', take().filter((l) => l.startsWith('K')), []);
  inactive.setActive(true);
  eq('first activation: awake, onEnable', take(), ['K.awake', 'K.onEnable']);
}

// ---- start before first update, even when added during update
{
  const scene = new Scene();
  scene.setRunning(true);
  const host = scene.add(new GameObject('host'));
  let spawned = false;
  add(host, 'H', {
    update: () => {
      if (spawned) return;
      spawned = true;
      add(host, 'N');
    },
  });
  take();
  frame(scene);
  eq('added during update: woken at once, first update next frame', take(), ['H.start', 'H.update', 'N.awake', 'N.onEnable', 'H.lateUpdate']);
  frame(scene);
  eq('…with start right before it', take(), ['N.start', 'H.update', 'N.update', 'H.lateUpdate', 'N.lateUpdate']);
}

// ---- add components inside awake and start
{
  const scene = new Scene();
  scene.setRunning(true);
  const o = scene.add(new GameObject('o'));
  add(o, 'A', { awake: (self) => add(self.gameObject, 'fromAwake'), start: (self) => add(self.gameObject, 'fromStart') });
  frame(scene);
  // Starts (and then updates) follow the order behaviours were enabled in: fromAwake was enabled inside A.awake.
  eq('components added in awake/start are woken and started before anyone updates', take(), [
    'A.awake', 'fromAwake.awake', 'fromAwake.onEnable', 'A.onEnable',
    'fromAwake.start', 'A.start', 'fromStart.awake', 'fromStart.onEnable', 'fromStart.start',
    'fromAwake.update', 'A.update', 'fromStart.update',
    'fromAwake.lateUpdate', 'A.lateUpdate', 'fromStart.lateUpdate',
  ]);
}

// ---- destroy during update: self, another, a parent
{
  const scene = new Scene();
  scene.setRunning(true);
  let armed = false;
  const self = scene.add(new GameObject('self'));
  add(self, 'S', { update: (b) => armed && GameObject.destroy(b.gameObject) });
  const killer = scene.add(new GameObject('killer'));
  const victim = scene.add(new GameObject('victim'));
  const parent = scene.add(new GameObject('parent'));
  const child = parent.add(new GameObject('child'));
  add(killer, 'K', {
    update: () => {
      if (!armed) return;
      GameObject.destroy(victim);
      GameObject.destroy(parent);
    },
  });
  add(victim, 'V');
  add(child, 'Ch');
  frame(scene);
  take();
  armed = true;
  // Frame 2: S destroys itself, K destroys V and the parent of Ch before they update.
  frame(scene);
  eq('destroyed objects get no further callbacks that frame; teardown runs at the end', take(), [
    'S.update', 'K.update', 'K.lateUpdate',
    'S.onDisable', 'S.onDestroy', 'V.onDisable', 'V.onDestroy', 'Ch.onDisable', 'Ch.onDestroy',
  ]);
  check('destroyed objects are detached', self.parent === null && victim.parent === null && parent.parent === null && child.isDestroyed);
  armed = false;
  frame(scene);
  eq('and gone afterwards', take(), ['K.update', 'K.lateUpdate']);

  // Destroying twice, or destroying during teardown, is safe.
  const twice = scene.add(new GameObject('twice'));
  add(twice, 'T', { onDestroy: () => GameObject.destroy(twice) });
  GameObject.destroy(twice);
  GameObject.destroy(twice);
  frame(scene);
  eq('double destroy runs teardown once', take().filter((l) => l.startsWith('T')), ['T.awake', 'T.onEnable', 'T.onDisable', 'T.onDestroy']);
}

// ---- outside a running scene destroy is immediate and silent
{
  const scene = new Scene();
  const o = scene.add(new GameObject('o'));
  const b = add(o, 'E');
  GameObject.destroy(o);
  check('destroy outside Play is immediate with no hooks', o.parent === null && b.isDestroyed && take().length === 0);
}

// ---- only overridden hooks are dispatched
{
  const scene = new Scene();
  scene.setRunning(true);
  const lists = scene as unknown as { _updateList: unknown[]; _fixedList: unknown[]; _lateList: unknown[] };
  for (let i = 0; i < 1000; i++) scene.add(new GameObject()).addComponent(Idle);
  const counters = [0, 1, 2].map(() => scene.add(new GameObject()).addComponent(Counter));
  frame(scene);
  eq('behaviours without per-frame hooks are in no dispatch list', [lists._updateList.length, lists._fixedList.length, lists._lateList.length], [3, 0, 0]);
  check('the others still run', counters.every((c) => c.n === 1));
  counters[1].enabled = false;
  frame(scene);
  eq('disabled behaviours leave the list', [lists._updateList.length, counters.map((c) => c.n)], [2, [2, 1, 2]]);
}

// ---- errors pause one behaviour and are reported
{
  const scene = new Scene();
  scene.setRunning(true);
  const reports: string[] = [];
  scene.behaviourError.connect((b, err, hook) => reports.push(`${(b as Logger).label}.${hook}: ${(err as Error).message}`));
  const o = scene.add(new GameObject());
  const bad = add(o, 'B', {
    update: () => {
      throw new Error('boom');
    },
  });
  add(o, 'G');
  frame(scene);
  frame(scene);
  eq('a throwing hook is reported once and paused', reports, ['B.update: boom']);
  check('…the others keep running', take().filter((l) => l === 'G.update').length === 2 && bad.failed);
}

// ---- signals owned by a behaviour disconnect when it is destroyed
{
  const scene = new Scene();
  scene.setRunning(true);
  const ping = new Signal<[number]>();
  let got = 0;
  const o = scene.add(new GameObject());
  add(o, 'L', { awake: (self) => ping.connect((n) => (got += n), self) });
  ping.emit(1);
  GameObject.destroy(o);
  frame(scene);
  ping.emit(10);
  check('owner connections drop when the behaviour is destroyed', got === 1 && ping.connectionCount === 0, `got=${got}`);
}

// ---- instantiate while running
{
  const scene = new Scene();
  const prefab = new GameObject('prefab');
  add(prefab, 'P');
  scene.setRunning(true);
  take();
  const copy = GameObject.instantiate(prefab, scene.root);
  frame(scene);
  eq('a detached prefab never wakes; its instance does', take(), ['P.awake', 'P.onEnable', 'P.start', 'P.update', 'P.lateUpdate']);
  check('instance is a separate component', copy.getComponent(Logger) !== prefab.getComponent(Logger));
}
