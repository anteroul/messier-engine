import { ASSETS_DIR, dirName, fileName, type Asset } from '../engine';
import type { Editor } from './editor';
import { ContextMenu, type MenuEntry } from './contextMenu';
import { kindOf } from './project';
import { button, el } from './ui';

/** dataTransfer type of an asset dragged out of the Assets panel; the value is the asset id. */
export const ASSET_MIME = 'application/x-messier-asset';

const ICONS = { model: '◆', image: '▣', sound: '♪', other: '·' } as const;
const HINTS = {
  model: 'Drag into the viewport or onto an object in the hierarchy',
  image: 'Drag onto an object to use as its texture, or onto the sky; double-click for the sky',
  sound: 'Drag into the viewport for an Audio Source',
  other: 'Used by a model next to it',
} as const;

/**
 * The project's imported files: assets/ of a folder project, by directory. New files appear as they're added to the
 * folder (or dropped here). Rows drag into the viewport, the hierarchy and the inspector.
 */
export class AssetsPanel {
  readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private dirty = true;

  constructor(private readonly editor: Editor) {
    this.list = el('div', { class: 'panel-body assets-list', tabindex: '0' });
    const importBtn = button('＋ Import', () => this.editor.pickFiles(), 'btn btn-small');
    importBtn.title = 'Import files into the project';
    this.root = el('section', { class: 'assets-panel', 'aria-label': 'Assets' }, [
      el('div', { class: 'panel-title panel-title-row' }, [el('span', { text: 'Assets' }), importBtn]),
      this.list,
    ]);
    // Files dropped here are imported without being placed in the scene.
    this.list.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        this.list.classList.add('drop-target');
      }
    });
    this.list.addEventListener('dragleave', () => this.list.classList.remove('drop-target'));
    this.list.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();
      this.list.classList.remove('drop-target');
      void this.editor.project.importFiles(Array.from(e.dataTransfer.files));
    });
    // Cheap to rebuild, but only when something changed and at most once a frame.
    const tick = () => {
      if (this.dirty) this.render();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  markDirty(): void {
    this.dirty = true;
  }

  private render(): void {
    this.dirty = false;
    const pm = this.editor.project;
    const assets = [...pm.assets].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    const rows: HTMLElement[] = [];
    let lastDir: string | null = null;
    for (const a of assets) {
      const dir = a.path ? dirName(a.path) : '';
      if (dir && dir !== lastDir) rows.push(el('div', { class: 'asset-dir', text: `${dir}/` }));
      lastDir = dir;
      rows.push(this.row(a, dir ? dir.split('/').length : 0));
    }
    if (!rows.length) {
      rows.push(el('p', {
        class: 'hint assets-empty',
        text: pm.folderName
          ? `Drop files here, onto the viewport, or into the ${ASSETS_DIR}/ folder of ${pm.folderName}.`
          : 'Drop models, images and sounds here or onto the viewport.',
      }));
    }
    this.list.replaceChildren(...rows);
  }

  private row(a: Asset, depth: number): HTMLElement {
    const kind = kindOf(a);
    const label = a.path ? fileName(a.path) : a.files[0]?.name ?? a.name;
    const row = el('div', {
      class: `asset-row asset-${kind}`,
      draggable: kind === 'other' ? undefined : 'true',
      title: `${a.path ? `${ASSETS_DIR}/${a.path}` : label}\n${HINTS[kind]}`,
      'data-asset': a.id,
    }, [el('span', { class: `asset-icon icon-${kind}`, text: ICONS[kind] }), el('span', { class: 'asset-name', text: label })]);
    row.style.paddingLeft = `${10 + depth * 12}px`;
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData(ASSET_MIME, a.id);
      e.dataTransfer?.setData('text/plain', label);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
    });
    row.addEventListener('dblclick', () => this.use(a));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      ContextMenu.open(this.menu(a), e.clientX, e.clientY);
    });
    return row;
  }

  /** The obvious thing to do with an asset: place a model or sound, show an image as the sky. */
  private use(a: Asset): void {
    const kind = kindOf(a);
    if (kind === 'image') {
      const tex = this.editor.project.texture(a.id);
      if (tex) this.editor.setSkyImage(tex);
    } else if (kind !== 'other') {
      const obj = this.editor.placeAsset(a);
      if (obj) this.editor.focusSelected();
    }
  }

  private menu(a: Asset): MenuEntry[] {
    const kind = kindOf(a);
    const pm = this.editor.project;
    const entries: MenuEntry[] = [];
    if (kind === 'model' || kind === 'sound') entries.push({ label: 'Add to Scene', action: () => this.use(a) });
    if (kind === 'image') entries.push({ label: 'Use as Sky', action: () => this.use(a) });
    if (entries.length) entries.push('separator');
    entries.push(
      {
        label: 'Rename…',
        action: () => {
          const name = prompt('New name', a.name);
          if (name) void pm.renameAsset(a, name);
        },
      },
      {
        label: 'Delete',
        action: () => {
          const uses = pm.usesOf(a.id);
          const where = pm.folderName ? ` from ${pm.folderName}` : '';
          const note = uses ? ` The open scene uses it ${uses} time${uses > 1 ? 's' : ''}; those objects keep it until the scene reloads.` : '';
          if (confirm(`Delete ${a.path ?? a.name}${where}?${note}`)) void pm.deleteAsset(a);
        },
      },
    );
    return entries;
  }
}

function sortKey(a: Asset): string {
  return (a.path ?? a.name).toLowerCase();
}
