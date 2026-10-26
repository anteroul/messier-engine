import { Behaviour } from './behaviours';
import type { GameObject, Scene } from './scene';
import { lineColumn, stripTypes, TranspileError } from './typescript';
// Scripts import the public engine API by name. This is a circular import
// (index re-exports this module), which is fine because it's only read lazily
// when a script is compiled.
import * as api from './index';

/** Module name scripts import the engine API from: `import { Script, vec3 } from 'messier'`. */
export const SCRIPT_MODULE = 'messier';

/**
 * Base class for TypeScript behaviour scripts. A script's default export
 * extends this; public number fields become inspector parameters.
 */
export class Script {
  /** The object this script is attached to. Set before start(). */
  object!: GameObject;

  /** Called when Play mode starts, before the first update. */
  start(): void {}

  /** Called every frame in Play mode. `time` is seconds since Play started. */
  update(_dt: number, _time: number): void {}

  /** The scene the object is in: findByName(), traverse(), activeCamera(), physics, background… */
  get scene(): Scene {
    const scene = this.object.scene;
    if (!scene) throw new Error(`'${this.object.name}' is not in a scene`);
    return scene;
  }

  /** First object in the scene with this name. */
  find(name: string): GameObject | null {
    let root = this.object;
    while (root.parent) root = root.parent;
    let found: GameObject | null = null;
    root.traverse((o) => {
      if (found) return false;
      if (o.name === name && o !== root) found = o;
    });
    return found;
  }
}

export interface ScriptDiagnostic {
  kind: 'compile' | 'runtime';
  message: string;
  /** 1-based; 0 when unknown. */
  line: number;
  column: number;
  /** Name of the object whose script instance threw (runtime errors). */
  object?: string;
}

type ScriptClass = new () => Script;

let nextScriptId = 1;
let compileCount = 0;
// Lines Function() adds before the body (V8 and SpiderMonkey wrap it in a
// header), measured once so stack trace lines map back to the source.
let functionLineOffset: number | null = null;
// Our own preamble line (the import destructuring) before the user's code.
const PREAMBLE_LINES = 1;

/** A TypeScript source file holding one behaviour class. */
export class ScriptAsset {
  readonly id = nextScriptId++;
  name: string;
  source: string;
  /** Last successfully compiled class; kept while the source has errors so running objects keep working. */
  ctor: ScriptClass | null = null;
  /** Bumped on every successful compile; attached behaviours hot-swap when it changes. */
  version = 0;
  /** Default values of the public number fields, from the last successful compile. */
  defaults: Record<string, number> = {};
  /** Compile error (at most one) followed by runtime errors since the last compile. */
  diagnostics: ScriptDiagnostic[] = [];
  /** The source that `ctor` was compiled from, or that the last failed compile saw. */
  compiledSource: string | null = null;
  library: ScriptLibrary | null = null;
  /** sourceURL of the active class, used to map stack traces to source lines. */
  private url = '';
  private pendingUrl = '';

  constructor(name: string, source: string) {
    this.name = name;
    this.source = source;
  }

  get compileError(): ScriptDiagnostic | null {
    return this.diagnostics.find((d) => d.kind === 'compile') ?? null;
  }

  /** Compiles `source`. On failure the previous class stays active and a compile diagnostic is recorded. */
  compile(): boolean {
    this.compiledSource = this.source;
    this.diagnostics = [];
    try {
      const cls = this.evaluate();
      const defaults = this.probeDefaults(cls.ctor, cls.privateMembers);
      this.ctor = cls.ctor;
      this.defaults = defaults;
      this.url = this.pendingUrl;
      this.version++;
      return true;
    } catch (err) {
      this.diagnostics = [this.toDiagnostic(err, 'compile', undefined, this.pendingUrl)];
      return false;
    }
  }

  private evaluate(): { ctor: ScriptClass; privateMembers: Set<string> } {
    const res = stripTypes(this.source, { module: true });
    const bindings: string[] = [];
    for (const imp of res.imports) {
      const at = lineColumn(this.source, imp.start);
      if (imp.from !== SCRIPT_MODULE) throw new TranspileError(`Scripts can only import from '${SCRIPT_MODULE}'`, at.line, at.column);
      if (imp.defaultName) throw new TranspileError(`'${SCRIPT_MODULE}' has no default export; use import { … }`, at.line, at.column);
      if (imp.namespace) bindings.push(`const ${imp.namespace} = __api;`);
      for (const { imported, local } of imp.names) {
        if (!(imported in api)) throw new TranspileError(`'${imported}' is not exported by '${SCRIPT_MODULE}'`, at.line, at.column);
        bindings.push(`const ${local} = __api.${imported};`);
      }
    }
    if (!res.defaultExport) throw new TranspileError('A script must `export default` a class that extends Script', 1, 1);
    // Unique URL per compile so devtools and stack traces never mix versions.
    this.pendingUrl = `scripts/${encodeURIComponent(this.name)}.ts?v${this.id}.${++compileCount}`;
    const body = `"use strict"; let __default; ${bindings.join(' ')}\n${res.code}\n;return ${res.defaultExport};\n//# sourceURL=${this.pendingUrl}`;
    let factory: (scope: typeof api) => unknown;
    try {
      factory = new Function('__api', body) as typeof factory;
    } catch (err) {
      // The engine's own SyntaxError has no position; the host may be able to find it.
      const pos = this.library?.locateSyntaxError?.(`${res.code}`) ?? null;
      throw new TranspileError((err as Error).message, pos?.line ?? 0, pos?.column ?? 0);
    }
    const ctor = factory(api);
    if (typeof ctor !== 'function' || !(ctor.prototype instanceof Script)) {
      throw new TranspileError('The default export must be a class that extends Script', 1, 1);
    }
    return { ctor: ctor as ScriptClass, privateMembers: res.privateMembers };
  }

  /** Instantiates the class once to read the initial values of its public number fields. */
  private probeDefaults(ctor: ScriptClass, privateMembers: Set<string>): Record<string, number> {
    const probe = new ctor();
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(probe)) {
      if (typeof v === 'number' && !k.startsWith('_') && !privateMembers.has(k)) out[k] = v;
    }
    return out;
  }

  /** Converts a thrown value into a diagnostic, mapping stack lines back to the source. */
  toDiagnostic(err: unknown, kind: ScriptDiagnostic['kind'], object?: string, url = this.url): ScriptDiagnostic {
    if (err instanceof TranspileError) return { kind, message: err.message, line: err.line, column: err.column, object };
    const e = err as Error;
    const message = e instanceof Error ? `${e.name}: ${e.message}` : String(err);
    const pos = locateInStack(e?.stack ?? '', url);
    return { kind, message, line: pos?.line ?? 0, column: pos?.column ?? 0, object };
  }

  /** Drops runtime errors from an earlier Play session. */
  clearRuntimeErrors(): void {
    this.diagnostics = this.diagnostics.filter((d) => d.kind !== 'runtime');
  }

  /** Records a runtime error (deduplicated) and tells the library's listener. */
  reportRuntimeError(diag: ScriptDiagnostic): void {
    const isNew = !this.diagnostics.some((d) => d.kind === 'runtime' && d.message === diag.message && d.line === diag.line);
    if (isNew) this.diagnostics.push(diag);
    this.library?.onRuntimeError?.(this, diag, isNew);
  }
}

function locateInStack(stack: string, url: string): { line: number; column: number } | null {
  if (!url) return null;
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${escaped}:(\\d+):(\\d+)`).exec(stack);
  if (!m) return null;
  const line = Number(m[1]) - getFunctionLineOffset() - PREAMBLE_LINES;
  return line >= 1 ? { line, column: Number(m[2]) } : null;
}

function getFunctionLineOffset(): number {
  if (functionLineOffset === null) {
    functionLineOffset = 0;
    try {
      new Function('__api', 'throw new Error()\n//# sourceURL=messier-calibrate')();
    } catch (err) {
      const m = /messier-calibrate:(\d+):\d+/.exec((err as Error).stack ?? '');
      if (m) functionLineOffset = Number(m[1]) - 1;
    }
  }
  return functionLineOffset;
}

/** The scene's script assets. */
export class ScriptLibrary {
  readonly scripts: ScriptAsset[] = [];
  /** Called when a running script throws (the behaviour is paused until the script changes). */
  onRuntimeError: ((script: ScriptAsset, diag: ScriptDiagnostic, isNew: boolean) => void) | null = null;
  /**
   * Optional host hook to find the position of a JavaScript syntax error the
   * type stripper let through. The editor implements it with a script element.
   */
  locateSyntaxError: ((code: string) => { line: number; column: number } | null) | null = null;

  add(script: ScriptAsset, index = this.scripts.length): ScriptAsset {
    if (!this.scripts.includes(script)) this.scripts.splice(index, 0, script);
    script.library = this;
    return script;
  }

  remove(script: ScriptAsset): void {
    const i = this.scripts.indexOf(script);
    if (i >= 0) this.scripts.splice(i, 1);
  }

  get(name: string): ScriptAsset | null {
    return this.scripts.find((s) => s.name === name) ?? null;
  }

  /** `base`, or `base 2`, `base 3`… if taken. */
  uniqueName(base: string, except?: ScriptAsset): string {
    const taken = (n: string) => this.scripts.some((s) => s !== except && s.name === n);
    if (!taken(base)) return base;
    for (let i = 2; ; i++) if (!taken(`${base}${i}`)) return `${base}${i}`;
  }
}

/**
 * Component that runs a ScriptAsset. Parameters edited in the inspector are
 * stored as overrides of the script's field defaults, so changing a default in
 * code updates every object that hasn't overridden it.
 */
export class ScriptBehaviour extends Behaviour {
  overrides: Record<string, number>;
  /** The live script object while playing. */
  instance: Script | null = null;
  /** Runtime error that paused this behaviour; cleared when the script recompiles or Play restarts. */
  error: ScriptDiagnostic | null = null;
  private version = 0;
  private obj: GameObject | null = null;

  constructor(
    readonly asset: ScriptAsset,
    overrides: Record<string, number> = {},
  ) {
    super({});
    this.overrides = { ...overrides };
    // Inspector-facing view: keys are the script's current fields, values are override ?? default.
    this.params = new Proxy({} as Record<string, number>, {
      get: (_t, k) => (typeof k === 'string' && k in this.asset.defaults ? (this.overrides[k] ?? this.asset.defaults[k]) : undefined),
      set: (_t, k, v) => {
        if (typeof k !== 'string') return false;
        this.overrides[k] = v;
        if (this.instance) (this.instance as unknown as Record<string, unknown>)[k] = v;
        return true;
      },
      has: (_t, k) => typeof k === 'string' && k in this.asset.defaults,
      ownKeys: () => Object.keys(this.asset.defaults),
      getOwnPropertyDescriptor: (_t, k) =>
        typeof k === 'string' && k in this.asset.defaults
          ? { value: this.overrides[k] ?? this.asset.defaults[k], writable: true, enumerable: true, configurable: true }
          : undefined,
    });
  }

  get type(): string {
    return this.asset.name;
  }

  start(obj: GameObject): void {
    this.obj = obj;
    this.error = null;
    this.instance = null;
    this.version = this.asset.version;
    this.instantiate(obj);
  }

  update(obj: GameObject, dt: number, time: number): void {
    if (this.asset.version !== this.version) this.hotSwap(obj);
    const inst = this.instance;
    if (!inst || this.error) return;
    try {
      inst.update(dt, time);
    } catch (err) {
      this.fail(err, obj);
    }
  }

  clone(): ScriptBehaviour {
    const b = new ScriptBehaviour(this.asset, this.overrides);
    b.enabled = this.enabled;
    return b;
  }

  private instantiate(obj: GameObject): void {
    const ctor = this.asset.ctor;
    if (!ctor) return;
    try {
      const inst = new ctor();
      this.applyParams(inst);
      inst.object = obj;
      this.instance = inst;
      inst.start();
    } catch (err) {
      this.fail(err, obj);
    }
  }

  /**
   * The script was recompiled while playing: keep the running instance (and
   * its state) but give it the new methods, plus any newly added fields.
   */
  private hotSwap(obj: GameObject): void {
    this.version = this.asset.version;
    const ctor = this.asset.ctor;
    const inst = this.instance;
    this.error = null;
    if (!ctor) return;
    if (!inst) return this.instantiate(this.obj ?? obj);
    try {
      const fresh = new ctor() as unknown as Record<string, unknown>;
      const target = inst as unknown as Record<string, unknown>;
      for (const k of Object.keys(fresh)) if (!(k in target)) target[k] = fresh[k];
      Object.setPrototypeOf(inst, ctor.prototype);
      this.applyParams(inst);
    } catch (err) {
      this.fail(err, obj);
    }
  }

  private applyParams(inst: Script): void {
    const target = inst as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(this.overrides)) if (k in this.asset.defaults) target[k] = v;
  }

  private fail(err: unknown, obj: GameObject): void {
    this.error = this.asset.toDiagnostic(err, 'runtime', obj.name);
    this.asset.reportRuntimeError(this.error);
  }
}
