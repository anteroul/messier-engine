import type { GameObject } from '../engine';
import { el } from './ui';
import type { Editor } from './editor';

/** Scene tree panel: selection, collapse, drag-and-drop re-parenting. */
export class HierarchyPanel {
  private dirty = true;
  private readonly collapsed = new Set<number>();
  private readonly rows = new Map<GameObject, HTMLElement>();
  private dragged: GameObject | null = null;

  constructor(
    private readonly editor: Editor,
    private readonly container: HTMLElement,
  ) {
    // Dropping on empty space moves the object to the scene root.
    container.addEventListener('dragover', (e) => {
      if (this.dragged) e.preventDefault();
    });
    container.addEventListener('drop', (e) => {
      if (!this.dragged || e.target !== container) return;
      e.preventDefault();
      this.editor.reparent(this.dragged, this.editor.scene.root);
      this.dragged = null;
    });
  }

  markDirty(): void {
    this.dirty = true;
  }

  update(): void {
    if (this.dirty) this.rebuild();
  }

  private rebuild(): void {
    this.dirty = false;
    this.rows.clear();
    const list = el('div', { class: 'tree' });
    const visit = (obj: GameObject, depth: number) => {
      list.append(this.makeRow(obj, depth));
      if (!this.collapsed.has(obj.id)) for (const c of obj.children) visit(c, depth + 1);
    };
    for (const c of this.editor.scene.root.children) visit(c, 0);
    if (this.editor.scene.root.children.length === 0) list.append(el('div', { class: 'empty', text: 'Scene is empty' }));
    this.container.replaceChildren(list);
    this.updateSelection();
  }

  private makeRow(obj: GameObject, depth: number): HTMLElement {
    const hasChildren = obj.children.length > 0;
    const toggle = el('span', { class: 'tree-toggle', text: hasChildren ? (this.collapsed.has(obj.id) ? '▸' : '▾') : '' });
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.collapsed.has(obj.id)) this.collapsed.delete(obj.id);
      else this.collapsed.add(obj.id);
      this.markDirty();
    });
    const icon = obj.light ? '✦' : obj.camera ? '◉' : obj.mesh ? '◆' : '○';
    const iconClass = obj.light ? 'icon-light' : obj.camera ? 'icon-camera' : obj.mesh ? 'icon-mesh' : 'icon-empty';
    const row = el('div', { class: `tree-row${obj.visible ? '' : ' hidden-obj'}`, draggable: 'true', title: obj.name }, [
      toggle,
      el('span', { class: `tree-icon ${iconClass}`, text: icon }),
      el('span', { class: 'tree-name', text: obj.name }),
    ]);
    row.style.paddingLeft = `${6 + depth * 14}px`;
    row.addEventListener('click', () => this.editor.select(obj));
    row.addEventListener('dblclick', () => this.editor.focusSelected());

    row.addEventListener('dragstart', (e) => {
      this.dragged = obj;
      e.dataTransfer?.setData('text/plain', String(obj.id));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => {
      this.dragged = null;
      row.classList.remove('drop-target');
    });
    row.addEventListener('dragover', (e) => {
      if (!this.dragged || this.dragged === obj || this.dragged.isAncestorOf(obj)) return;
      e.preventDefault();
      row.classList.add('drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', (e) => {
      row.classList.remove('drop-target');
      if (!this.dragged || this.dragged === obj || this.dragged.isAncestorOf(obj)) return;
      e.preventDefault();
      e.stopPropagation();
      this.collapsed.delete(obj.id);
      this.editor.reparent(this.dragged, obj);
      this.dragged = null;
    });
    this.rows.set(obj, row);
    return row;
  }

  updateSelection(): void {
    const sel = this.editor.selected;
    // Expand ancestors so the selection is visible.
    if (sel) {
      let expanded = false;
      for (let p = sel.parent; p; p = p.parent) if (this.collapsed.delete(p.id)) expanded = true;
      if (expanded) {
        this.rebuild();
        return;
      }
    }
    for (const [obj, row] of this.rows) row.classList.toggle('selected', obj === sel);
    this.rows.get(sel!)?.scrollIntoView({ block: 'nearest' });
  }
}
