import { Signal, type GameObject } from '../engine';

/**
 * The editor's selection, shared by the hierarchy, inspector and viewport: a set of objects plus the *active* one
 * (most recently clicked, shown in the inspector and moved by the gizmo) and the *anchor* that Shift+click ranges
 * start from. Selection changes aren't undo steps. No DOM, so it's unit-testable.
 */
export class Selection {
  /** Emitted after any change. */
  readonly changed = new Signal();
  private _items: GameObject[] = [];
  private _active: GameObject | null = null;
  private _anchor: GameObject | null = null;

  /** Selected objects in the order they were selected. */
  get items(): readonly GameObject[] {
    return this._items;
  }

  get active(): GameObject | null {
    return this._active;
  }

  get size(): number {
    return this._items.length;
  }

  has(obj: GameObject): boolean {
    return this._items.includes(obj);
  }

  /** Selects only `obj` (null clears). Plain click. */
  set(obj: GameObject | null): void {
    this.apply(obj ? [obj] : [], obj, obj);
  }

  /** Replaces the selection; `active` defaults to the last object. */
  setMany(objs: readonly GameObject[], active: GameObject | null = objs[objs.length - 1] ?? null): void {
    this.apply([...new Set(objs)], active, active);
  }

  /** Adds or removes `obj`. Ctrl/Cmd+click. */
  toggle(obj: GameObject): void {
    if (this.has(obj)) {
      const rest = this._items.filter((o) => o !== obj);
      this.apply(rest, this._active === obj ? (rest[rest.length - 1] ?? null) : this._active, obj);
    } else {
      this.apply([...this._items, obj], obj, obj);
    }
  }

  /**
   * Selects everything between the anchor and `obj` in `order` (the visible tree order). Shift+click. Without an
   * anchor in `order` it selects just `obj`. The anchor stays put, so further Shift+clicks re-span from it.
   */
  range(obj: GameObject, order: readonly GameObject[]): void {
    const a = this._anchor ? order.indexOf(this._anchor) : -1;
    const b = order.indexOf(obj);
    if (a < 0 || b < 0) return this.set(obj);
    const span = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    this.apply(span, obj, this._anchor);
  }

  /** Selects every object in `order`. Ctrl/Cmd+A. */
  selectAll(order: readonly GameObject[]): void {
    this.apply([...order], this._active && order.includes(this._active) ? this._active : (order[order.length - 1] ?? null), this._anchor);
  }

  clear(): void {
    this.apply([], null, null);
  }

  /** Drops objects that no longer pass `keep` (e.g. removed from the scene by undo). */
  retain(keep: (obj: GameObject) => boolean): void {
    if (this._items.every(keep)) return;
    const rest = this._items.filter(keep);
    const active = this._active && keep(this._active) ? this._active : (rest[rest.length - 1] ?? null);
    this.apply(rest, active, this._anchor && keep(this._anchor) ? this._anchor : active);
  }

  private apply(items: GameObject[], active: GameObject | null, anchor: GameObject | null): void {
    const same = items.length === this._items.length && items.every((o, i) => o === this._items[i]) && active === this._active;
    this._anchor = anchor;
    if (same) return;
    this._items = items;
    this._active = active;
    this.changed.emit();
  }
}
