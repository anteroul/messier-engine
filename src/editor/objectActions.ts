import type { GameObject, Scene } from '../engine';
import type { History } from './history';
import type { Selection } from './selection';

/** What the actions need from the editor. `scene` and `history` are read on every call (Play swaps both). */
export interface ActionHost {
  readonly scene: Scene;
  readonly history: History;
  readonly selection: Selection;
  /** The hierarchy changed (panels should rebuild). */
  objectsChanged(): void;
}

interface SelectionState {
  items: GameObject[];
  active: GameObject | null;
}

/**
 * Hierarchy editing on the selection: create, cut, copy, paste, duplicate, delete and visibility. Every change is
 * one undo step however many objects it touches, acts only on the top-most selected objects (a selected child of
 * a selected parent comes along with it), and undo puts the selection back. No DOM, so it's unit-testable.
 */
export class ObjectActions {
  // Detached deep copies taken at copy time; pasting clones them again, so the clipboard can be pasted repeatedly.
  private clipboard: GameObject[] = [];

  constructor(private readonly host: ActionHost) {}

  get hasSelection(): boolean {
    return this.host.selection.size > 0;
  }

  get canPaste(): boolean {
    return this.clipboard.length > 0;
  }

  /** Number of objects on the clipboard. */
  get clipboardSize(): number {
    return this.clipboard.length;
  }

  /** Adds `obj` under `parent` (default: the scene root, at the end), selects it. Undoable. */
  add(obj: GameObject, parent: GameObject = this.host.scene.root, label = `Add ${obj.name}`, index?: number): GameObject {
    this.insert([{ obj, parent, index: index ?? parent.children.length }], label, false);
    return obj;
  }

  copy(): void {
    const roots = topMost(this.host.selection.items);
    if (roots.length) this.clipboard = roots.map((o) => o.clone());
  }

  /** Copy + delete, as one undo step. */
  cut(): void {
    const roots = topMost(this.host.selection.items);
    if (!roots.length) return;
    this.clipboard = roots.map((o) => o.clone());
    this.remove(roots, `Cut ${describe(roots)}`);
  }

  /**
   * Pastes copies of the clipboard as siblings right after the active object (or at the end of the scene root when
   * nothing is selected), or with `asChild` at the end of the active object's children.
   */
  paste(asChild = false): GameObject[] {
    if (!this.clipboard.length) return [];
    const active = this.host.selection.active;
    if (asChild && !active) return [];
    const parent = asChild ? active! : (active?.parent ?? this.host.scene.root);
    let index = asChild || !active ? parent.children.length : parent.children.indexOf(active) + 1;
    const placed = this.clipboard.map((c) => ({ obj: c.clone(), parent, index: index++ }));
    this.insert(placed, `Paste ${describe(placed.map((p) => p.obj))}`, true);
    return placed.map((p) => p.obj);
  }

  /** Copies of the top-most selected objects, each placed right after its original. */
  duplicate(): GameObject[] {
    const roots = topMost(this.host.selection.items);
    if (!roots.length) return [];
    // Copies of several originals under one parent shift the later indices; account for the ones placed before.
    const shift = new Map<GameObject, number>();
    const placed = roots.map((o) => {
      const parent = o.parent!;
      const before = shift.get(parent) ?? 0;
      shift.set(parent, before + 1);
      return { obj: o.clone(), parent, index: parent.children.indexOf(o) + 1 + before };
    });
    this.insert(placed, `Duplicate ${describe(roots)}`, true);
    return placed.map((p) => p.obj);
  }

  /** Deletes the top-most selected objects. */
  delete(): void {
    const roots = topMost(this.host.selection.items);
    if (roots.length) this.remove(roots, `Delete ${describe(roots)}`);
  }

  /** true / false when every selected object agrees, 'mixed' otherwise, null with nothing selected. */
  visibleState(): boolean | 'mixed' | null {
    const items = this.host.selection.items;
    if (!items.length) return null;
    const shown = items.filter((o) => o.visible).length;
    return shown === items.length ? true : shown === 0 ? false : 'mixed';
  }

  /** Hides everything if all selected objects are visible; otherwise (none or mixed) shows them all. */
  toggleVisible(): void {
    this.setVisible(this.visibleState() !== true);
  }

  setVisible(visible: boolean): void {
    const objs = this.host.selection.items.filter((o) => o.visible !== visible);
    if (!objs.length) return;
    const before = objs.map((o) => o.visible);
    const apply = (values: (o: GameObject, i: number) => boolean) => {
      objs.forEach((o, i) => (o.visible = values(o, i)));
      this.host.objectsChanged();
    };
    apply(() => visible);
    this.host.history.push({
      label: `${visible ? 'Show' : 'Hide'} ${describe(objs)}`,
      undo: () => apply((_o, i) => before[i]),
      redo: () => apply(() => visible),
    });
  }

  /**
   * Inserts objects (in order, so each index is valid when it's used) and selects them. One undo step. With
   * `rename`, names are made unique among the siblings, counting the other objects inserted with them.
   */
  private insert(placed: { obj: GameObject; parent: GameObject; index: number }[], label: string, rename: boolean): void {
    const sel = this.host.selection;
    const before = this.saveSelection();
    const objs = placed.map((p) => p.obj);
    if (rename) {
      const names = new Map<GameObject, GameObject[]>();
      for (const p of placed) {
        const siblings = names.get(p.parent) ?? [...p.parent.children];
        p.obj.name = uniqueName(p.obj.name, siblings);
        siblings.push(p.obj);
        names.set(p.parent, siblings);
      }
    }
    const redo = () => {
      for (const p of placed) p.parent.add(p.obj, Math.min(p.index, p.parent.children.length));
      sel.setMany(objs);
      this.host.objectsChanged();
    };
    redo();
    this.host.history.push({
      label,
      undo: () => {
        for (const o of objs) o.parent?.remove(o);
        this.restoreSelection(before);
        this.host.objectsChanged();
      },
      redo,
    });
  }

  /** Detaches `roots` (top-most, in hierarchy order). Undo re-inserts them where they were and reselects them. */
  private remove(roots: GameObject[], label: string): void {
    const sel = this.host.selection;
    const before = this.saveSelection();
    const places = roots.map((obj) => ({ obj, parent: obj.parent!, index: obj.parent!.children.indexOf(obj) }));
    const redo = () => {
      for (const p of places) p.parent.remove(p.obj);
      sel.retain((o) => !roots.some((r) => r === o || r.isAncestorOf(o)));
      this.host.objectsChanged();
    };
    redo();
    this.host.history.push({
      label,
      // Hierarchy order means earlier siblings go back first, so each saved index is right again.
      undo: () => {
        for (const p of places) p.parent.add(p.obj, Math.min(p.index, p.parent.children.length));
        this.restoreSelection(before);
        this.host.objectsChanged();
      },
      redo,
    });
  }

  private saveSelection(): SelectionState {
    const s = this.host.selection;
    return { items: [...s.items], active: s.active };
  }

  private restoreSelection(state: SelectionState): void {
    this.host.selection.setMany(state.items, state.active);
  }
}

/**
 * The objects that aren't inside another one in the list (so a selected parent brings its selected children along
 * once), excluding detached objects, sorted in hierarchy order.
 */
export function topMost(objs: readonly GameObject[]): GameObject[] {
  const set = new Set(objs);
  const out = objs.filter((o) => {
    if (!o.parent) return false;
    for (let p: GameObject | null = o.parent; p; p = p.parent) if (set.has(p)) return false;
    return true;
  });
  return out.sort(compareHierarchy);
}

/** `name`, or `stem (n)` with the smallest free n ≥ 1 if a sibling already has it (`Cube`, `Cube (1)`, …). */
export function uniqueName(name: string, siblings: readonly GameObject[]): string {
  const taken = new Set(siblings.map((s) => s.name));
  if (!taken.has(name)) return name;
  const stem = name.replace(/ \(\d+\)$/, '');
  for (let n = 1; ; n++) if (!taken.has(`${stem} (${n})`)) return `${stem} (${n})`;
}

/** Orders objects as they appear in the tree (depth-first). */
function compareHierarchy(a: GameObject, b: GameObject): number {
  const pa = indexPath(a), pb = indexPath(b);
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return pa.length - pb.length;
}

function indexPath(o: GameObject): number[] {
  const path: number[] = [];
  for (let c: GameObject | null = o; c?.parent; c = c.parent) path.unshift(c.parent.children.indexOf(c));
  return path;
}

function describe(objs: readonly GameObject[]): string {
  return objs.length === 1 ? objs[0].name : `${objs.length} objects`;
}
