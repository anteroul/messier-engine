/** Built-in axes: WASD and the arrow keys. `vertical` is positive for W / Up. */
export type AxisName = 'horizontal' | 'vertical';

const AXES: Record<AxisName, [negative: string[], positive: string[]]> = {
  horizontal: [['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']],
  vertical: [['KeyS', 'ArrowDown'], ['KeyW', 'ArrowUp']],
};

/**
 * Keyboard state for scripts, by `KeyboardEvent.code` ('KeyW', 'ArrowUp',
 * 'Space', 'ShiftLeft'…), so bindings don't move with the keyboard layout.
 *
 * The engine never listens to the DOM itself: the host (the editor, or a game
 * page) forwards events with `keyDown`/`keyUp`, which lets it decide when the
 * game has the keyboard. `Engine` calls `endFrame()` after each update, so
 * `pressed`/`released` are true for exactly one update, even for a tap that
 * went down and up between two frames.
 */
export class InputState {
  private readonly down = new Set<string>();
  private readonly pressedNow = new Set<string>();
  private readonly releasedNow = new Set<string>();

  /** True while any of the keys is held. */
  isDown(...codes: string[]): boolean {
    return codes.some((c) => this.down.has(c));
  }

  /** True on the update after any of the keys went down (key repeat doesn't count). */
  pressed(...codes: string[]): boolean {
    return codes.some((c) => this.pressedNow.has(c));
  }

  /** True on the update after any of the keys was let go. */
  released(...codes: string[]): boolean {
    return codes.some((c) => this.releasedNow.has(c));
  }

  /**
   * -1, 0 or 1. Either a built-in axis (`'horizontal'`: A/D and ←/→,
   * `'vertical'`: S/W and ↓/↑) or your own negative and positive key lists.
   * Holding both sides gives 0.
   */
  axis(name: AxisName): number;
  axis(negative: string[], positive: string[]): number;
  axis(a: AxisName | string[], b?: string[]): number {
    const [neg, pos] = typeof a === 'string' ? AXES[a] : [a, b ?? []];
    return (this.isDown(...pos) ? 1 : 0) - (this.isDown(...neg) ? 1 : 0);
  }

  /** Keys currently held, for debugging. */
  get keys(): string[] {
    return [...this.down];
  }

  keyDown(code: string): void {
    if (this.down.has(code)) return; // auto-repeat
    this.down.add(code);
    this.pressedNow.add(code);
  }

  keyUp(code: string): void {
    if (!this.down.delete(code)) return;
    this.releasedNow.add(code);
  }

  /** Forget everything, e.g. on window blur, where keyup events never arrive. */
  reset(): void {
    this.down.clear();
    this.pressedNow.clear();
    this.releasedNow.clear();
  }

  endFrame(): void {
    this.pressedNow.clear();
    this.releasedNow.clear();
  }
}

/** The keyboard, shared by every script: `import { input } from 'messier'`. */
export const input = new InputState();
