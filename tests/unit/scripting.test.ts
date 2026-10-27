import { readFileSync } from 'node:fs';
import { check, eq } from './harness';
import { GameObject, Scene } from '@root/src/engine/scene.ts';
import { Behaviour } from '@root/src/engine/behaviours.ts';
import { Script, ScriptAsset } from '@root/src/engine/scripting.ts';

const v1 = `import { Script } from 'messier';
export default class Spin extends Script {
  speed = 2;
  ticks = 0;
  update(): void { this.ticks++; }
}
`;

// ---- a script attached before its asset compiles is a placeholder that becomes the real class
{
  const scene = new Scene();
  const asset = scene.scripts.add(new ScriptAsset('Spin', v1));
  const o = scene.add(new GameObject('o'));
  const s = o.attachComponent(asset.create({ speed: 5 }));
  check('placeholder before compiling', Object.getPrototypeOf(s) === Script.prototype && s.typeName === 'Spin');
  check('compiles', asset.compile(), JSON.stringify(asset.diagnostics));
  check('…and the placeholder adopts the class with defaults + overrides', s.constructor !== Script && (s as any).speed === 5 && (s as any).ticks === 0);
  check('registry lists it under the new class', scene.query(asset.ctor!).length === 1 && scene.query(Behaviour).length === 1);
  eq('params: overrides over defaults', { ...s.params }, { speed: 5, ticks: 0 });
}

// ---- hot swap while running keeps state, re-registers, and picks up new hooks
{
  const scene = new Scene();
  const asset = scene.scripts.add(new ScriptAsset('Spin', v1));
  asset.compile();
  const o = scene.add(new GameObject('o'));
  const s = o.attachComponent(asset.create());
  for (let i = 0; i < 3; i++) scene.update(1 / 60, i / 60, true);
  const oldClass = asset.ctor!;
  asset.source = v1.replace('this.ticks++;', 'this.ticks += 10;').replace('ticks = 0;', 'ticks = 0;\n  late = 0;\n  lateUpdate(): void { this.late++; }');
  check('recompiles', asset.compile(), JSON.stringify(asset.diagnostics));
  scene.update(1 / 60, 0.1, true);
  check('state kept, new method used, new field added', (s as any).ticks === 13 && (s as any).late === 1, `ticks=${(s as any).ticks} late=${(s as any).late}`);
  check('query follows the new class', scene.query(asset.ctor!).includes(s) && !scene.query(oldClass).includes(s));

  const copy = GameObject.instantiate(o);
  const cs = copy.getComponent(Script)!;
  scene.update(1 / 60, 0.2, true);
  check('instantiated scripts keep the asset link and current values', cs.asset === asset && (cs as any).ticks === 13 + 10 && cs !== s);

  GameObject.destroy(copy);
  scene.update(1 / 60, 0.3, true);
  check('destroyed scripts stop tracking the asset', !asset._instances.has(cs) && asset._instances.has(s));
}

// ---- edit-mode instances follow default changes; overridden fields keep their values
{
  const scene = new Scene();
  const asset = scene.scripts.add(new ScriptAsset('Spin', v1));
  asset.compile();
  const a = scene.add(new GameObject('a')).attachComponent(asset.create());
  const b = scene.add(new GameObject('b')).attachComponent(asset.create({ speed: 9 }));
  asset.source = v1.replace('speed = 2;', 'speed = 3;');
  asset.compile();
  eq('defaults update unless overridden', [(a as any).speed, (b as any).speed, a.params.speed, b.params.speed], [3, 9, 3, 9]);
  a.params.speed = 4;
  eq('inspector edits become overrides and set the field', [a.overrides.speed, (a as any).speed], [4, 4]);
}

// ---- the example in docs/scripting.md compiles and does what it says
{
  const doc = readFileSync(`${process.env.PROJECT_ROOT}/docs/scripting.md`, 'utf8');
  const example = /```ts\n(import \{ Script[\s\S]*?)```/.exec(doc)?.[1] ?? '';
  const scene = new Scene();
  const asset = scene.scripts.add(new ScriptAsset('Spinner', example));
  check('docs example compiles', asset.compile(), JSON.stringify(asset.diagnostics));
  const o = scene.add(new GameObject('Spinner obj'));
  const s = o.attachComponent(asset.create());
  const laps: number[] = [];
  const logged: string[] = [];
  const log = console.log;
  console.log = (msg: string) => logged.push(msg);
  try {
    scene.update(0, 0, true);
    (s as any).lap.connect((n: number) => laps.push(n));
    for (let i = 0; i < 300; i++) scene.update(1 / 60, i / 60, true); // 5 s at 90°/s = 1.25 turns
  } finally {
    console.log = log;
  }
  eq('docs example announces its lap', [laps, logged], [[1], ['Spinner obj finished lap 1']]);
}
