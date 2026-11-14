import type { Project, ProjectScene } from '../engine';
import type { Editor } from './editor';
import { createZip } from './zip';

// File → Build: a Unity-style Build Settings dialog (which scenes go in, in what order) and the export itself, a .zip
// with one self-contained index.html: the game runtime (messier-player.js, see scripts/player-plugin.mjs) and the
// project's built scenes, scripts and assets as an embedded .messier file. It opens straight from the file system.

const PLAYER_URL = `${import.meta.env.BASE_URL}messier-player.js`;

export class BuildDialog {
  readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly titleInput: HTMLInputElement;
  private readonly buildButton: HTMLButtonElement;
  private readonly status: HTMLElement;
  private dragged: string | null = null;
  private building = false;

  constructor(private readonly editor: Editor) {
    this.root = el('div', 'build-dialog');
    this.root.id = 'build-dialog';
    this.root.hidden = true;
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.close();
    });
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.close();
      }
    });

    const card = el('div', 'build-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'build-dialog-title');
    const header = el('div', 'build-header');
    const h = el('h2');
    h.id = 'build-dialog-title';
    h.textContent = 'Build Settings';
    const closeX = button('×', 'btn btn-small', () => this.close());
    closeX.title = 'Close (Esc)';
    closeX.setAttribute('aria-label', 'Close');
    header.append(h, closeX);

    const listTitle = el('div', 'build-section');
    listTitle.textContent = 'Scenes In Build';
    this.list = el('ul', 'build-scenes');
    this.list.setAttribute('aria-label', 'Scenes in build');
    const hint = el('p', 'build-hint');
    hint.innerHTML =
      'Drag to reorder. The first scene starts the game. Scripts switch scenes with ' +
      '<code>sceneManager.loadScene(name or index)</code>.';

    const titleRow = el('label', 'build-field');
    const titleLabel = el('span');
    titleLabel.textContent = 'Game title';
    this.titleInput = el('input', 'text');
    this.titleInput.type = 'text';
    this.titleInput.spellcheck = false;
    this.titleInput.addEventListener('change', () => {
      const p = this.project;
      const title = this.titleInput.value.trim();
      p.build.title = title === p.name ? '' : title;
      this.editor.project.markChanged();
    });
    titleRow.append(titleLabel, this.titleInput);

    const footer = el('div', 'build-footer');
    this.status = el('span', 'build-status');
    this.status.setAttribute('role', 'status');
    this.buildButton = button('Build', 'btn build-run', () => void this.build());
    this.buildButton.title = 'Download the game as a .zip';
    footer.append(this.status, button('Close', 'btn', () => this.close()), this.buildButton);

    card.append(header, listTitle, this.list, hint, titleRow, footer);
    this.root.append(card);
  }

  private get project(): Project {
    return this.editor.project.project;
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(): void {
    // The current scene's latest edits go into the build, so make sure the project has them.
    this.editor.project.flush();
    this.root.hidden = false;
    this.status.textContent = '';
    this.refresh();
    this.buildButton.focus();
  }

  close(): void {
    this.root.hidden = true;
  }

  refresh(): void {
    const p = this.project;
    this.titleInput.value = gameTitle(p);
    this.titleInput.placeholder = p.name;
    const entries = p.buildList();
    let index = 0;
    this.list.replaceChildren(
      ...entries.map(({ scene, enabled }, i) => {
        const li = el('li', 'build-scene');
        li.dataset.id = scene.id;
        li.draggable = true;
        li.classList.toggle('excluded', !enabled);
        const grip = el('span', 'build-grip');
        grip.textContent = '⠿';
        grip.setAttribute('aria-hidden', 'true');
        const label = el('label', 'build-name');
        const check = el('input');
        check.type = 'checkbox';
        check.checked = enabled;
        check.addEventListener('change', () => this.update(entries.map((e) => (e.scene === scene ? { ...e, enabled: check.checked } : e))));
        const name = el('span');
        name.textContent = scene.name;
        label.append(check, name);
        const idx = el('span', 'build-index');
        idx.textContent = enabled ? String(index++) : '';
        idx.title = enabled ? 'Build index' : '';
        const move = (delta: number) => {
          const j = i + delta;
          if (j < 0 || j >= entries.length) return;
          const next = [...entries];
          [next[i], next[j]] = [next[j], next[i]];
          this.update(next);
          this.list.querySelector<HTMLButtonElement>(`[data-id="${scene.id}"] .build-move-${delta < 0 ? 'up' : 'down'}`)?.focus();
        };
        const up = button('▲', 'btn btn-small build-move-up', () => move(-1));
        up.title = 'Move up';
        up.disabled = i === 0;
        const down = button('▼', 'btn btn-small build-move-down', () => move(1));
        down.title = 'Move down';
        down.disabled = i === entries.length - 1;
        li.append(grip, label, idx, up, down);
        this.bindDrag(li, entries);
        return li;
      }),
    );
    this.buildButton.disabled = this.building || index === 0;
    if (index === 0 && !this.building) this.status.textContent = 'Select at least one scene.';
    else if (!this.building && this.status.textContent === 'Select at least one scene.') this.status.textContent = '';
  }

  private update(entries: { scene: ProjectScene; enabled: boolean }[]): void {
    this.project.build.scenes = entries.map((e) => ({ id: e.scene.id, enabled: e.enabled }));
    this.editor.project.markChanged();
    this.refresh();
  }

  private bindDrag(li: HTMLElement, entries: { scene: ProjectScene; enabled: boolean }[]): void {
    li.addEventListener('dragstart', (e) => {
      this.dragged = li.dataset.id!;
      e.dataTransfer?.setData('text/plain', li.dataset.id!);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => {
      this.dragged = null;
      for (const r of this.list.children) r.classList.remove('dragging', 'drop-before', 'drop-after');
    });
    li.addEventListener('dragover', (e) => {
      if (!this.dragged || this.dragged === li.dataset.id) return;
      e.preventDefault();
      const after = e.offsetY > li.clientHeight / 2;
      li.classList.toggle('drop-before', !after);
      li.classList.toggle('drop-after', after);
    });
    li.addEventListener('dragleave', () => li.classList.remove('drop-before', 'drop-after'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = entries.findIndex((x) => x.scene.id === this.dragged);
      if (from < 0 || this.dragged === li.dataset.id) return;
      const after = e.offsetY > li.clientHeight / 2;
      const next = [...entries];
      const [moved] = next.splice(from, 1);
      const target = next.findIndex((x) => x.scene.id === li.dataset.id);
      next.splice(target + (after ? 1 : 0), 0, moved);
      this.update(next);
    });
  }

  /** Builds the selected scenes and downloads the game. */
  async build(): Promise<boolean> {
    if (this.building) return false;
    const pm = this.editor.project;
    if (this.editor.engine.playing) this.editor.stopPlay();
    const warnings: string[] = [];
    pm.flush(warnings);
    const project = this.project;
    const scenes = project.buildScenes();
    if (!scenes.length) {
      this.editor.notify('Select at least one scene to build', 'error');
      return false;
    }
    this.building = true;
    this.buildButton.disabled = true;
    this.status.textContent = 'Building…';
    try {
      const res = await fetch(PLAYER_URL);
      if (!res.ok) throw new Error(`Could not get the game runtime (${PLAYER_URL}: HTTP ${res.status})`);
      const runtime = await res.text();
      const title = gameTitle(project);
      const html = gameHTML(title, runtime, project.subset(scenes).encode());
      const zip = await createZip([{ name: 'index.html', data: html }]);
      const file = `${fileSafe(title)}.zip`;
      download(zip, file, 'application/zip');

      const broken = this.editor.scene.scripts.scripts.filter((s) => s.diagnostics.length > 0);
      const noCamera = scenes.filter((s) => !hasCamera(s.data.objects)).map((s) => s.name);
      if (broken.length) warnings.push(`${broken.map((s) => `${s.name}.ts`).join(', ')} ${broken.length > 1 ? 'have' : 'has'} errors`);
      if (noCamera.length) warnings.push(`${noCamera.join(', ')} ${noCamera.length > 1 ? 'have' : 'has'} no camera`);
      const size = zip.byteLength >= 1e6 ? `${(zip.byteLength / 1e6).toFixed(1)} MB` : `${Math.ceil(zip.byteLength / 1e3)} kB`;
      this.status.textContent = `Built ${file} (${scenes.length} scene${scenes.length > 1 ? 's' : ''}, ${size})`;
      this.editor.notify(`Built ${file}`, 'success');
      if (warnings.length) this.editor.notify(`Build warning: ${warnings.join('; ')}`, 'error');
      return true;
    } catch (err) {
      this.status.textContent = 'Build failed.';
      this.editor.notify(`Build failed: ${(err as Error).message}`, 'error');
      return false;
    } finally {
      this.building = false;
      this.refresh();
    }
  }
}

export function gameTitle(project: Project): string {
  return project.build.title.trim() || project.name;
}

/** The exported page. `runtime` is a classic script; `projectBytes` an encoded .messier project. */
export function gameHTML(title: string, runtime: string, projectBytes: Uint8Array): string {
  // Inline scripts end at the first `</script`, wherever it is. In JS source, `<\/` means the same as `</`.
  const script = runtime.replace(/<\/(script)/gi, '<\\/$1');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="Messier Engine" />
<title>${escapeHTML(title)}</title>
<style>
html, body { margin: 0; height: 100%; overflow: hidden; background: #000; color: #dcdfe1; font: 15px/1.6 system-ui, sans-serif; }
canvas { display: block; width: 100vw; height: 100vh; outline: none; touch-action: none; }
#error { position: fixed; inset: 0; display: grid; place-content: center; padding: 24px; text-align: center; white-space: pre-line; }
#error[hidden] { display: none; }
</style>
</head>
<body>
<canvas id="game" tabindex="0"></canvas>
<div id="error" hidden></div>
<script id="messier-project" type="application/octet-stream">${bytesToBase64(projectBytes)}</script>
<script>${script}</script>
</body>
</html>
`;
}

/** True if any object in the tree has a camera component. */
function hasCamera(objects: unknown): boolean {
  if (!Array.isArray(objects)) return false;
  return objects.some((o) => o && typeof o === 'object' && ('camera' in o || hasCamera((o as { children?: unknown }).children)));
}

function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

function escapeHTML(s: string): string {
  return s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

function fileSafe(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Game';
}

export function download(bytes: Uint8Array<ArrayBuffer>, name: string, type = 'application/octet-stream'): void {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function button(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', className);
  b.type = 'button';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}
