import { ScriptBehaviour, type GameObject, type ScriptAsset } from '../engine';
import { CodeEditor } from './codeEditor';
import { button, el } from './ui';
import type { Editor } from './editor';

/** Debounce between the last keystroke and the live recompile. */
const COMPILE_DELAY_MS = 350;

/**
 * The Scripts tab: script list, code editor and a side panel with problems,
 * usages and an API reference. Edits compile live; a successful compile
 * hot-swaps the class on every object using the script, even while playing.
 */
export class ScriptsView {
  current: ScriptAsset | null = null;
  private readonly editors = new Map<ScriptAsset, CodeEditor>();
  private readonly list: HTMLElement;
  private readonly host: HTMLElement;
  private readonly nameInput: HTMLInputElement;
  private readonly status: HTMLElement;
  private readonly position: HTMLElement;
  private readonly problems: HTMLElement;
  private readonly usages: HTMLElement;
  private readonly main: HTMLElement;
  private readonly empty: HTMLElement;
  private compileTimer = 0;

  constructor(
    private readonly editor: Editor,
    root: HTMLElement,
  ) {
    this.list = el('div', { class: 'panel-body script-list' });
    const listPanel = el('aside', { class: 'panel script-list-panel' }, [
      el('div', { class: 'panel-title panel-title-row' }, [el('span', { text: 'Scripts' }), button('＋ New', () => this.createScript(), 'btn btn-small new-script')]),
      this.list,
    ]);

    this.nameInput = el('input', { class: 'text script-name', type: 'text', 'aria-label': 'Script name' });
    this.nameInput.addEventListener('change', () => {
      if (this.current) this.editor.renameScript(this.current, this.nameInput.value);
      this.nameInput.value = this.current?.name ?? '';
    });
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.nameInput.blur();
      e.stopPropagation();
    });
    this.status = el('span', { class: 'script-status' });
    this.position = el('span', { class: 'script-position' });
    const bar = el('div', { class: 'script-bar' }, [
      el('span', { class: 'script-ext', text: '{ }' }),
      this.nameInput,
      el('span', { class: 'script-ext', text: '.ts' }),
      el('span', { class: 'spacer' }),
      button('⤓ Download', () => this.download(), 'btn btn-small'),
      button('🗑', () => this.current && this.editor.deleteScript(this.current), 'btn btn-small delete-script'),
    ]);
    bar.querySelector<HTMLButtonElement>('.delete-script')!.title = 'Delete script';
    this.host = el('div', { class: 'script-editor-host' });
    const statusBar = el('div', { class: 'script-statusbar' }, [this.status, el('span', { class: 'spacer' }), this.position]);
    this.empty = el('div', { class: 'script-empty' }, [
      el('p', { text: 'No script open.' }),
      el('p', { class: 'hint', text: 'Scripts are TypeScript classes that run on objects in Play mode. Attach them from the inspector’s Behaviours section.' }),
      button('＋ New script', () => this.createScript(), 'btn'),
    ]);
    this.main = el('main', { class: 'script-main' }, [bar, this.host, statusBar]);

    this.problems = el('div', { class: 'script-problems' });
    this.usages = el('div', { class: 'script-usages' });
    const info = el('aside', { class: 'panel script-info' }, [
      el('div', { class: 'panel-title', text: 'Problems' }),
      this.problems,
      el('div', { class: 'panel-title', text: 'Used by' }),
      this.usages,
      el('div', { class: 'panel-title', text: 'Reference' }),
      reference(),
    ]);
    root.append(listPanel, this.main, this.empty, info);
    this.showScript(null);
  }

  /** Called when the tab becomes visible. */
  show(script?: ScriptAsset | null): void {
    const scripts = this.editor.scene.scripts.scripts;
    const target = script ?? (this.current && scripts.includes(this.current) ? this.current : scripts[0] ?? null);
    this.refresh();
    this.showScript(target);
  }

  /** Rebuilds the list and side panel (after scripts are added, removed, renamed or recompiled). */
  refresh(): void {
    const scripts = this.editor.scene.scripts.scripts;
    if (this.current && !scripts.includes(this.current)) this.showScript(scripts[0] ?? null);
    for (const [asset] of this.editors) if (!scripts.includes(asset)) this.editors.delete(asset);
    const rows = scripts.map((s) => {
      const err = s.diagnostics.length > 0;
      const r = el('div', { class: `script-row${s === this.current ? ' selected' : ''}`, title: err ? s.diagnostics[0].message : `${s.name}.ts` }, [
        el('span', { class: `script-dot ${err ? 'dot-error' : 'dot-ok'}` }),
        el('span', { class: 'script-row-name', text: `${s.name}.ts` }),
        el('span', { class: 'script-row-count', text: String(this.usersOf(s).length || '') }),
      ]);
      r.addEventListener('click', () => this.showScript(s));
      return r;
    });
    if (!scripts.length) rows.push(el('div', { class: 'empty', text: 'No scripts yet' }));
    this.list.replaceChildren(...rows);
    if (this.current) this.nameInput.value = this.current.name;
    this.renderInfo();
  }

  /** Re-applies markers after diagnostics changed (runtime errors while playing). */
  diagnosticsChanged(script: ScriptAsset): void {
    if (script === this.current) this.applyDiagnostics();
    this.refresh();
  }

  /** Compiles the open script now instead of waiting for the debounce. */
  compileNow(): void {
    clearTimeout(this.compileTimer);
    const s = this.current;
    if (!s || s.compiledSource === s.source) return;
    this.editor.compileScript(s);
    this.applyDiagnostics();
    this.refresh();
  }

  private showScript(script: ScriptAsset | null): void {
    if (this.current && this.current !== script) this.compileNow();
    this.current = script;
    this.main.hidden = !script;
    this.empty.hidden = !!script;
    if (!script) {
      this.host.replaceChildren();
      this.renderInfo();
      return;
    }
    let ed = this.editors.get(script);
    if (!ed) {
      ed = new CodeEditor(script.source);
      const e = ed;
      ed.onChange = (text) => {
        script.source = text;
        this.setStatus('Editing…', 'pending');
        clearTimeout(this.compileTimer);
        this.compileTimer = window.setTimeout(() => this.compileNow(), COMPILE_DELAY_MS);
      };
      ed.onSave = () => {
        this.compileNow();
        this.editor.notify(script.compileError ? `${script.name}.ts has errors` : `${script.name}.ts compiled`, script.compileError ? 'error' : 'success');
      };
      ed.onCursor = (line, col) => (this.position.textContent = `Ln ${line}, Col ${col}`);
      this.editors.set(script, e);
    } else ed.value = script.source;
    this.host.replaceChildren(ed.root);
    this.nameInput.value = script.name;
    this.applyDiagnostics();
    this.refresh();
    requestAnimationFrame(() => ed!.focus());
  }

  private applyDiagnostics(): void {
    const s = this.current;
    if (!s) return;
    const ed = this.editors.get(s);
    ed?.setMarkers(s.diagnostics.filter((d) => d.line > 0).map((d) => ({ line: d.line, column: d.column, message: d.message, severity: d.kind === 'compile' ? 'error' : 'warning' })));
    const err = s.compileError;
    if (err) this.setStatus(`✗ ${err.line ? `Line ${err.line}: ` : ''}${err.message}`, 'error');
    else if (s.diagnostics.length) this.setStatus(`⚠ ${s.diagnostics.length} runtime error${s.diagnostics.length > 1 ? 's' : ''} (behaviour paused until the script changes)`, 'warning');
    else this.setStatus(this.editor.engine.playing ? '✓ Compiled — hot-reloaded into the running scene' : '✓ Compiled', 'ok');
  }

  private setStatus(text: string, kind: 'ok' | 'error' | 'warning' | 'pending'): void {
    this.status.textContent = text;
    this.status.className = `script-status status-${kind}`;
  }

  private renderInfo(): void {
    const s = this.current;
    if (!s) {
      this.problems.replaceChildren(el('p', { class: 'hint', text: 'No script open.' }));
      this.usages.replaceChildren();
      return;
    }
    const diags = s.diagnostics;
    this.problems.replaceChildren(
      ...(diags.length
        ? diags.map((d) => {
            const item = el('button', { class: `problem problem-${d.kind}`, type: 'button' }, [
              el('span', { class: 'problem-loc', text: d.line ? `${d.line}:${d.column}` : '—' }),
              el('span', { class: 'problem-msg', text: d.message + (d.object ? ` (on ${d.object})` : '') }),
            ]);
            item.addEventListener('click', () => d.line && this.editors.get(s)?.reveal(d.line, d.column));
            return item;
          })
        : [el('p', { class: 'hint', text: 'No problems.' })]),
    );
    const users = this.usersOf(s);
    const rows = users.map((o) => {
      const r = el('button', { class: 'usage', type: 'button', text: o.name });
      r.addEventListener('click', () => {
        this.editor.setView('scene');
        this.editor.select(o);
      });
      return r;
    });
    this.usages.replaceChildren(...(rows.length ? rows : [el('p', { class: 'hint', text: 'Not attached to any object. Add it from an object’s Behaviours section in the inspector.' })]));
  }

  private usersOf(script: ScriptAsset): GameObject[] {
    const out: GameObject[] = [];
    this.editor.scene.traverse((o) => {
      if (o.behaviours.some((b) => b instanceof ScriptBehaviour && b.asset === script)) out.push(o);
    });
    return out;
  }

  private createScript(): void {
    const s = this.editor.createScript();
    this.show(s);
  }

  private download(): void {
    const s = this.current;
    if (!s) return;
    const a = el('a', { href: URL.createObjectURL(new Blob([s.source], { type: 'text/plain' })), download: `${s.name}.ts` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}

function reference(): HTMLElement {
  const item = (code: string, text: string) => el('div', { class: 'ref-item' }, [el('code', { text: code }), el('span', { text })]);
  return el('div', { class: 'script-reference' }, [
    item("import { … } from 'messier'", 'The engine API: Script, vec3, quat, mat4, GameObject, Light, RigidBody…'),
    item('export default class X extends Script', 'One behaviour class per script.'),
    item('speed = 2', 'Public number fields are inspector parameters (private, protected and _-prefixed fields are not).'),
    item('start()', 'Called when Play starts.'),
    item('update(dt, time)', 'Called every frame while playing. dt and time are in seconds.'),
    item('this.object', 'The GameObject: transform, mesh, material, light, rigidBody, children.'),
    item('this.scene', 'The Scene: findByName(), traverse(), activeCamera(), physics, background…'),
    item('this.find(name)', 'Another object in the scene by name.'),
    item("input.isDown('KeyW', 'ArrowUp')", 'Keyboard (import input). Also pressed()/released() for one frame, axis(\'horizontal\' | \'vertical\') for WASD/arrows → -1…1. Esc stops Play.'),
    el('p', { class: 'hint', text: 'Types are checked by syntax only: annotations are erased, not type-checked. Enums, namespaces, decorators and parameter properties aren’t supported. Ctrl+S compiles now, Ctrl+/ toggles comments, Tab / Shift+Tab indents.' }),
  ]);
}
