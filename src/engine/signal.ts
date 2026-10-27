// Typed signals (Godot-style): `const hit = new Signal<[damage: number]>(); hit.connect((d) => …); hit.emit(3)`.
// emit() allocates nothing beyond its rest arguments. Listeners connected during an emit first run on the next one, and listeners
// disconnected during an emit are skipped from then on.

type Listener<Args extends unknown[]> = (...args: Args) => void;

interface Slot {
  // Typed by the owning Signal; stored loosely so owners can hold slots of any signal.
  fn: object | null;
  owner: object | null;
  once: boolean;
  signal: Signal<never[]>;
}

// Connections made with an owner, so destroying the owner (a component) can drop them all at once.
const ownerSlots = new WeakMap<object, Set<Slot>>();

export class Signal<Args extends unknown[] = []> {
  private _slots: Slot[] = [];
  private _emitting = 0;
  // Disconnects during an emit only clear `fn`; the array is compacted once the outermost emit ends.
  private _holes = false;

  /**
   * Calls `fn` on every emit until disconnected. With an `owner` (usually a component), the connection is dropped
   * automatically when the owner is destroyed. Returns a function that disconnects this connection.
   */
  connect(fn: Listener<Args>, owner?: object): () => void {
    return this._add(fn, owner ?? null, false);
  }

  /** Like connect(), but disconnects after the first call. */
  once(fn: Listener<Args>, owner?: object): () => void {
    return this._add(fn, owner ?? null, true);
  }

  /** Removes every connection of `fn`. Returns whether there was one. */
  disconnect(fn: Listener<Args>): boolean {
    let found = false;
    for (const s of this._slots) {
      if (s.fn === fn) {
        this._drop(s);
        found = true;
      }
    }
    return found;
  }

  /** Removes every connection. */
  disconnectAll(): void {
    for (const s of this._slots) if (s.fn) this._drop(s);
  }

  isConnected(fn: Listener<Args>): boolean {
    return this._slots.some((s) => s.fn === fn);
  }

  get connectionCount(): number {
    let n = 0;
    for (const s of this._slots) if (s.fn) n++;
    return n;
  }

  emit(...args: Args): void {
    const slots = this._slots;
    // Listeners added during this emit land past `end` and wait for the next one.
    const end = slots.length;
    this._emitting++;
    try {
      for (let i = 0; i < end; i++) {
        const s = slots[i];
        const fn = s.fn as Listener<Args> | null;
        if (!fn) continue;
        if (s.once) this._drop(s);
        fn(...args);
      }
    } finally {
      if (--this._emitting === 0 && this._holes) this._compact();
    }
  }

  /** Resolves with the arguments of the next emit: `const [damage] = await hit.next()`. */
  next(owner?: object): Promise<Args> {
    return new Promise((resolve) => {
      this._add((...args: Args) => resolve(args), owner ?? null, true);
    });
  }

  /** Disconnects every connection (on any signal) made with `owner`. Called when a component is destroyed. */
  static disconnectOwner(owner: object): void {
    const set = ownerSlots.get(owner);
    if (!set) return;
    ownerSlots.delete(owner);
    for (const s of set) {
      s.owner = null;
      s.signal._drop(s);
    }
  }

  private _add(fn: Listener<Args>, owner: object | null, once: boolean): () => void {
    const slot: Slot = { fn, owner, once, signal: this as unknown as Signal<never[]> };
    this._slots.push(slot);
    if (owner) {
      let set = ownerSlots.get(owner);
      if (!set) ownerSlots.set(owner, (set = new Set()));
      set.add(slot);
    }
    return () => this._drop(slot);
  }

  private _drop(slot: Slot): void {
    if (!slot.fn) return;
    slot.fn = null;
    if (slot.owner) ownerSlots.get(slot.owner)?.delete(slot);
    slot.owner = null;
    if (this._emitting > 0) this._holes = true;
    else this._compact();
  }

  private _compact(): void {
    this._holes = false;
    let j = 0;
    const slots = this._slots;
    for (let i = 0; i < slots.length; i++) if (slots[i].fn) slots[j++] = slots[i];
    slots.length = j;
  }
}
