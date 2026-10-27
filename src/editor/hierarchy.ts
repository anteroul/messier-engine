import type { GameObject } from '../engine';
import { el } from './ui';
import type { Editor } from './editor';

/** Scene tree panel: selection (click, Ctrl/Cmd+click, Shift+click), collapse, drag-and-drop re-parenting. */
export class HierarchyPanel {
  private dirty = true;
  private readonly collapsed = new Set<number>();
  private readonly rows = new Map<GameObject, HTMLElement>();
  private readonly rowObjects = new WeakMap<HTMLElement, GameObject>();
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
    // Focusable, so keyboard shortcuts can target the hierarchy; clicking empty space clears the selection.
    container.tabIndex = 0;
    container.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('.tree-row')) this.editor.selection.clear();
    });
    container.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const row = (e.target as HTMLElement).closest<HTMLElement>('.tree-row');
      // Focus first, so the menu hands focus back here and the panel's shortcuts keep working afterwards.
      container.focus({ preventScroll: true });
      this.editor.openHierarchyMenu(row ? (this.rowObjects.get(row) ?? null) : null, e.clientX, e.clientY);
    });
  }

  /** Objects in the order their rows are shown (collapsed subtrees left out). */
  visibleOrder(): GameObject[] {
    return [...this.rows.keys()];
  }

  markDirty(): void {
    this.dirty = true;
  }

  update(): void {
    if (this.dirty) this.rebuild();
  }

  private rebuild(reveal = false): void {
    this.dirty = false;
    // Keep the scroll position: a rebuild (after any edit) shouldn't jump, or close an open context menu by scrolling.
    const scrollTop = this.container.scrollTop;
    this.rows.clear();
    const list = el('div', { class: 'tree' });
    const visit = (obj: GameObject, depth: number) => {
      list.append(this.makeRow(obj, depth));
      if (!this.collapsed.has(obj.id)) for (const c of obj.children) visit(c, depth + 1);
    };
    for (const c of this.editor.scene.root.children) visit(c, 0);
    if (this.editor.scene.root.children.length === 0) list.append(el('div', { class: 'empty', text: 'Scene is empty' }));
    this.container.replaceChildren(list);
    this.container.scrollTop = scrollTop;
    this.updateSelection(reveal);
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
    row.addEventListener('click', (e) => {
      const sel = this.editor.selection;
      if (e.shiftKey) sel.range(obj, this.visibleOrder());
      else if (e.ctrlKey || e.metaKey) sel.toggle(obj);
      else sel.set(obj);
    });
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
    this.rowObjects.set(row, obj);
    return row;
  }

  /** Highlights the selected rows; with `reveal`, expands and scrolls to the active object. */
  updateSelection(reveal = true): void {
    const sel = this.editor.selected;
    // Expand ancestors so the active object is visible.
    if (sel && reveal) {
      let expanded = false;
      for (let p = sel.parent; p; p = p.parent) if (this.collapsed.delete(p.id)) expanded = true;
      if (expanded) {
        this.rebuild(true);
        return;
      }
    }
    const selection = this.editor.selection;
    for (const [obj, row] of this.rows) {
      row.classList.toggle('selected', selection.has(obj));
      row.classList.toggle('active', obj === sel);
    }
    if (reveal) this.rows.get(sel!)?.scrollIntoView({ block: 'nearest' });
  }
}
