import { Behaviour } from './behaviours';
import type { GameObject, Scene } from './scene';
import { lineColumn, stripTypes, TranspileError } from './typescript';
// Scripts import the public engine API by name. This is a circular import
// (index re-exports this module), which is fine because it's only read lazily
// when a script is compiled.
import * as api from './index';

/** Module name scripts import the engine API from: `import { Script, vec3 } from 'messier'`. */
export const SCRIPT_MODULE = 'messier';

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
  /** Script components created from this asset; they adopt each newly compiled class. */
  readonly _instances = new Set<Script>();
  /** sourceURL of the active class, used to map stack traces to source lines. */
  private url = '';
  private pendingUrl = '';

  constructor(name: string, source: string) {
    this.name = name;
    this.source = source;
  }

  /**
   * A new Script component running this asset, with inspector `overrides` of the field defaults. Before the asset
   * has compiled it's a plain Script that turns into the real class on the first successful compile.
   */
  create(overrides: Record<string, number> = {}): Script {
    let s: Script;
    try {
      s = this.ctor ? new this.ctor() : new Script();
    } catch {
      s = new Script();
    }
    s._bindAsset(this, overrides, true);
    return s;
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
      for (const s of [...this._instances]) s._hotSwap();
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

  /** `base`, or `base2`, `base3`… if taken. */
  uniqueName(base: string, except?: ScriptAsset): string {
    const taken = (n: string) => this.scripts.some((s) => s !== except && s.name === n);
    if (!taken(base)) return base;
    for (let i = 2; ; i++) if (!taken(`${base}${i}`)) return `${base}${i}`;
  }
}

/**
 * Base class for TypeScript behaviour scripts: `export default class Spin extends Script { … }`. A Script is a
 * Behaviour with every lifecycle hook, plus the `object`, `scene` and `find()` shortcuts and the link to the
 * ScriptAsset it was compiled from. Public number fields become inspector parameters; values edited there are kept
 * as overrides of the defaults in code.
 */
export class Script extends Behaviour {
  private _asset: ScriptAsset | null = null;
  private _overrides: Record<string, number> = {};
  private _error: ScriptDiagnostic | null = null;
  private _version = -1;

  /** The object this script is attached to (same as gameObject). */
  get object(): GameObject {
    return this.gameObject;
  }

  /** The scene the object is in: findByName(), query(), getGroup(), activeCamera(), physics, background… */
  get scene(): Scene {
    const obj = attached(this, 'this.scene');
    const scene = obj.scene;
    if (!scene) throw new Error(`'${obj.name}' is not in a scene`);
    return scene;
  }

  /** First object in the scene with this name. */
  find(name: string): GameObject | null {
    let root = attached(this, 'this.find()');
    while (root.parent) root = root.parent;
    let found: GameObject | null = null;
    root.traverse((o) => {
      if (found) return false;
      if (o.name === name && o !== root) found = o;
    });
    return found;
  }

  /** The asset this script runs. */
  get asset(): ScriptAsset | null {
    return this._asset;
  }

  /** Parameter values set in the inspector, by field name. */
  get overrides(): Readonly<Record<string, number>> {
    return this._overrides;
  }

  /** The runtime error that paused this script, until it recompiles or the scene restarts. */
  get error(): ScriptDiagnostic | null {
    return this._error;
  }

  get typeName(): string {
    return this._asset?.name ?? super.typeName;
  }

  paramNames(): string[] {
    return this._asset ? Object.keys(this._asset.defaults) : super.paramNames();
  }

  getParam(name: string): number | undefined {
    if (!this._asset) return super.getParam(name);
    return name in this._asset.defaults ? (this._overrides[name] ?? this._asset.defaults[name]) : undefined;
  }

  setParam(name: string, value: number): void {
    this._overrides[name] = value;
    super.setParam(name, value);
  }

  /** Copies the current field values and keeps the asset link and overrides. */
  clone(): Script {
    const c = super.clone() as Script;
    c._bindAsset(this._asset, this._overrides, false);
    return c;
  }

  _bindAsset(asset: ScriptAsset | null, overrides: Readonly<Record<string, number>>, applyFields: boolean): void {
    this._asset?._instances.delete(this);
    this._asset = asset;
    this._overrides = { ...overrides };
    this._version = asset?.version ?? -1;
    asset?._instances.add(this);
    if (applyFields) this._applyOverrides();
  }

  _disposed(): void {
    this._asset?._instances.delete(this);
  }

  _fail(err: unknown, hook: Parameters<Behaviour['_fail']>[1]): void {
    const asset = this._asset;
    if (!asset) return super._fail(err, hook);
    this._failed = true;
    // A start() that threw runs again (on a fresh state) once the script is fixed.
    if (hook === 'start') this._started = false;
    this._error = asset.toDiagnostic(err, 'runtime', this.attached ? this.gameObject.name : undefined);
    asset.reportRuntimeError(this._error);
  }

  _resetLifecycle(): void {
    super._resetLifecycle();
    this._error = null;
  }

  /**
   * Adopts the asset's newly compiled class in place, so references to this component stay valid. A running script
   * keeps its state and only gains new fields; one that hasn't started (or whose start() threw) is reset to the new
   * defaults and starts again, and so is a script outside a running scene.
   */
  _hotSwap(): void {
    const asset = this._asset;
    const ctor = asset?.ctor;
    if (!asset || !ctor || this._version === asset.version) return;
    this._version = asset.version;
    let fresh: Record<string, unknown>;
    try {
      fresh = new ctor() as unknown as Record<string, unknown>;
    } catch (err) {
      this._fail(err, 'awake');
      return;
    }
    const base = baseKeys();
    const target = this as unknown as Record<string, unknown>;
    const placeholder = Object.getPrototypeOf(this) === Script.prototype;
    const keepState = this._awoken && this._started && !placeholder;
    for (const k of Object.keys(fresh)) if (!base.has(k) && (!keepState || !(k in target))) target[k] = fresh[k];

    // The class changes, so so does the set of registry lists and per-frame hooks it belongs in.
    const registered = this._registeredIn;
    registered?._unregister(this);
    const lists = this._inLists ? this._lifeScene : null;
    lists?._removeFromLists(this);
    Object.setPrototypeOf(this, ctor.prototype);
    registered?._register(this);
    this._applyOverrides();
    this._failed = false;
    this._error = null;
    if (!keepState) this._started = false;
    if (this._enabledCalled && this._lifeScene) {
      if (this._started) this._lifeScene._addToLists(this);
      else this._lifeScene._queueStart(this);
    }
  }

  private _applyOverrides(): void {
    const defaults = this._asset?.defaults ?? {};
    for (const [k, v] of Object.entries(this._overrides)) if (k in defaults) super.setParam(k, v);
  }
}

let scriptBaseKeys: Set<string> | null = null;
/** Fields every Script has (engine state), which a hot swap must never overwrite. */
function baseKeys(): Set<string> {
  return (scriptBaseKeys ??= new Set(Object.keys(new Script())));
}

// Field initializers run before the script is attached, which would otherwise fail with a less helpful message.
function attached(script: Script, what: string): GameObject {
  if (!script.attached) throw new Error(`${what} is available from start() on, not in field initializers`);
  return script.gameObject;
}

