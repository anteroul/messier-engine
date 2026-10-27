import { el } from './ui';

/** One clickable entry. Callbacks are evaluated when the menu (or submenu) opens. */
export interface MenuItem {
  label: string;
  /** Platform-neutral shortcut, e.g. `Mod+C`, `Mod+Shift+Z`, `Delete`. Shown with ⌘/⇧ on macOS, Ctrl+/Shift+ elsewhere. */
  shortcut?: string;
  /** Disabled items stay visible but can't be focused or chosen. Default: enabled. */
  enabled?: () => boolean;
  /** Makes the item a checkbox (`menuitemcheckbox`); `'mixed'` shows an indeterminate mark. */
  checked?: () => boolean | 'mixed';
  action?: () => void;
  /** Opens a submenu instead of running an action. */
  children?: MenuEntry[];
}

export type MenuEntry = MenuItem | 'separator';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MAC_KEYS: Record<string, string> = { Mod: '⌘', Shift: '⇧', Alt: '⌥', Ctrl: '⌃', Delete: '⌫', Backspace: '⌫', Enter: '↩', Escape: '⎋' };
const PC_KEYS: Record<string, string> = { Mod: 'Ctrl', Delete: 'Del', Escape: 'Esc' };
const MAC_ORDER = ['Ctrl', 'Alt', 'Shift', 'Mod'];

/** Renders a shortcut like `Mod+Shift+Z` for the current platform (`⇧⌘Z` on macOS, `Ctrl+Shift+Z` elsewhere). */
export function formatShortcut(shortcut: string, mac = IS_MAC): string {
  const parts = shortcut.split('+');
  if (!mac) return parts.map((p) => PC_KEYS[p] ?? p).join('+');
  const key = parts.pop()!;
  parts.sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b));
  return [...parts, key].map((p) => MAC_KEYS[p] ?? p).join('');
}

let current: ContextMenu | null = null;

/**
 * A popup menu built from data. Opens at a point, stays inside the window (flipping or shifting, submenus too),
 * and closes on Esc, outside clicks, scroll, window blur or resize, or after an item is chosen. Keyboard:
 * ↑/↓ (skipping disabled items), Home/End, → and ← for submenus, Enter/Space to choose.
 */
export class ContextMenu {
  /** Called once after the menu closes. */
  onClose: (() => void) | null = null;
  private readonly panels: HTMLElement[] = [];
  private readonly restoreFocus: HTMLElement | null;
  private readonly listeners: [EventTarget, string, EventListener, boolean][] = [];
  private closed = false;

  /** Opens a menu at client coordinates (x, y), closing any other open menu. */
  static open(entries: MenuEntry[], x: number, y: number): ContextMenu {
    current?.close();
    return (current = new ContextMenu(entries, x, y));
  }

  /** The open menu, if any. */
  static get current(): ContextMenu | null {
    return current;
  }

  private constructor(entries: MenuEntry[], x: number, y: number) {
    this.restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = this.buildPanel(entries, 0);
    placeAt(panel, x, y, x, true);
    panel.focus();
    const on = (target: EventTarget, type: string, fn: EventListener, capture = true) => {
      target.addEventListener(type, fn, capture);
      this.listeners.push([target, type, fn, capture]);
    };
    on(window, 'keydown', (e) => this.onKey(e as KeyboardEvent));
    on(window, 'pointerdown', (e) => {
      if (!this.contains(e.target)) this.close();
    });
    on(window, 'scroll', (e) => {
      if (!this.contains(e.target)) this.close();
    });
    on(window, 'blur', () => this.close(), false);
    on(window, 'resize', () => this.close(), false);
  }

  /** The root panel element (for tests and styling hooks). */
  get element(): HTMLElement {
    return this.panels[0];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [target, type, fn, capture] of this.listeners) target.removeEventListener(type, fn, capture);
    for (const p of this.panels) p.remove();
    this.panels.length = 0;
    if (current === this) current = null;
    // Give focus back (e.g. to the hierarchy) so its keyboard shortcuts keep working.
    if (this.restoreFocus?.isConnected) this.restoreFocus.focus({ preventScroll: true });
    this.onClose?.();
  }

  private contains(target: EventTarget | null): boolean {
    return target instanceof Node && this.panels.some((p) => p.contains(target));
  }

  private buildPanel(entries: MenuEntry[], level: number): HTMLElement {
    const panel = el('div', { class: 'context-menu', role: 'menu', tabindex: '-1' });
    panel.setAttribute('aria-orientation', 'vertical');
    for (const entry of entries) {
      if (entry === 'separator') {
        panel.append(el('div', { class: 'context-menu-separator', role: 'separator' }));
        continue;
      }
      const enabled = entry.enabled?.() ?? true;
      const checked = entry.checked?.();
      const role = checked === undefined ? 'menuitem' : 'menuitemcheckbox';
      const mark = checked === true ? '✓' : checked === 'mixed' ? '–' : '';
      const item = el('div', { class: 'context-menu-item', role, tabindex: '-1' }, [
        el('span', { class: 'context-menu-check', text: mark }),
        el('span', { class: 'context-menu-label', text: entry.label }),
        el('span', { class: 'context-menu-shortcut', text: entry.children ? '▸' : entry.shortcut ? formatShortcut(entry.shortcut) : '' }),
      ]);
      if (checked !== undefined) item.setAttribute('aria-checked', checked === 'mixed' ? 'mixed' : String(checked));
      if (!enabled) item.setAttribute('aria-disabled', 'true');
      if (entry.children) {
        item.setAttribute('aria-haspopup', 'menu');
        item.setAttribute('aria-expanded', 'false');
      }
      if (entry.shortcut) item.setAttribute('aria-keyshortcuts', entry.shortcut.replace('Mod', IS_MAC ? 'Meta' : 'Control'));
      item.addEventListener('pointerenter', () => {
        if (!enabled) return;
        item.focus();
        this.closeFrom(level + 1);
        if (entry.children) this.openSubmenu(item, entry, level);
      });
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (enabled) this.activate(item, entry, level);
      });
      itemEntries.set(item, entry);
      panel.append(item);
    }
    panel.addEventListener('contextmenu', (e) => e.preventDefault());
    document.body.append(panel);
    this.panels[level] = panel;
    return panel;
  }

  private activate(item: HTMLElement, entry: MenuItem, level: number): void {
    if (entry.children) {
      this.openSubmenu(item, entry, level);
      this.focusFirst(this.panels[level + 1]);
      return;
    }
    this.close();
    entry.action?.();
  }

  private openSubmenu(item: HTMLElement, entry: MenuItem, level: number): void {
    if (this.panels[level + 1]?.dataset.owner === item.id && item.id) return;
    this.closeFrom(level + 1);
    const panel = this.buildPanel(entry.children!, level + 1);
    item.id ||= `context-menu-item-${++nextId}`;
    panel.dataset.owner = item.id;
    panel.setAttribute('aria-labelledby', item.id);
    item.setAttribute('aria-expanded', 'true');
    const r = item.getBoundingClientRect();
    // Beside the item, flipping to the left edge if it doesn't fit on the right.
    placeAt(panel, r.right - 2, r.top - 5, r.left + 2, false);
  }

  /** Removes submenus at `level` and deeper. */
  private closeFrom(level: number): void {
    while (this.panels.length > level) {
      const p = this.panels.pop()!;
      const owner = p.dataset.owner ? document.getElementById(p.dataset.owner) : null;
      owner?.setAttribute('aria-expanded', 'false');
      p.remove();
    }
  }

  private onKey(e: KeyboardEvent): void {
    // The menu owns the keyboard while open: nothing reaches the editor's shortcuts.
    e.stopImmediatePropagation();
    const active = document.activeElement as HTMLElement | null;
    const level = Math.max(0, this.panels.findIndex((p) => p.contains(active)));
    const panel = this.panels[level];
    const item = active?.classList.contains('context-menu-item') ? active : null;
    const entry = item ? itemEntries.get(item) : undefined;
    switch (e.key) {
      case 'ArrowDown':
        this.move(panel, item, 1);
        break;
      case 'ArrowUp':
        this.move(panel, item, -1);
        break;
      case 'Home':
        this.focusFirst(panel);
        break;
      case 'End':
        this.move(panel, null, -1);
        break;
      case 'ArrowRight':
        if (item && entry?.children && item.getAttribute('aria-disabled') !== 'true') this.activate(item, entry, level);
        break;
      case 'ArrowLeft':
        if (level > 0) {
          const owner = document.getElementById(panel.dataset.owner ?? '');
          this.closeFrom(level);
          owner?.focus();
        }
        break;
      case 'Enter':
      case ' ':
        if (item && entry && item.getAttribute('aria-disabled') !== 'true') this.activate(item, entry, level);
        break;
      case 'Escape':
        if (level > 0) {
          const owner = document.getElementById(panel.dataset.owner ?? '');
          this.closeFrom(level);
          owner?.focus();
        } else {
          this.close();
        }
        break;
      case 'Tab':
        this.close();
        break;
      default:
        return; // let other keys (e.g. a shortcut) through untouched, apart from stopping propagation
    }
    e.preventDefault();
  }

  private focusFirst(panel: HTMLElement | undefined): void {
    if (panel) this.move(panel, null, 1);
  }

  /** Focuses the next enabled item in `dir`, wrapping around. */
  private move(panel: HTMLElement, from: HTMLElement | null, dir: 1 | -1): void {
    const items = [...panel.querySelectorAll<HTMLElement>('.context-menu-item:not([aria-disabled="true"])')];
    if (!items.length) return;
    const i = from ? items.indexOf(from) : dir === 1 ? -1 : items.length;
    items[(i + dir + items.length) % items.length].focus();
  }
}

let nextId = 0;
const itemEntries = new WeakMap<HTMLElement, MenuItem>();

/**
 * Positions a fixed panel with its top-left at (x, y). If it overflows the right edge it's flipped to end at
 * `flipX` (the cursor, or a submenu's parent item); a root menu that overflows the bottom opens upwards. Then it's
 * shifted to stay inside the window.
 */
function placeAt(panel: HTMLElement, x: number, y: number, flipX: number, flipY: boolean): void {
  const margin = 4;
  const { width, height } = panel.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = x + width > vw - margin ? flipX - width : x;
  let top = flipY && y + height > vh - margin ? y - height : y;
  left = Math.max(margin, Math.min(left, vw - width - margin));
  top = Math.max(margin, Math.min(top, vh - height - margin));
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
}
