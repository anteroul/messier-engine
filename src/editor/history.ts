/** A reversible editor action. `redo` is not called on push: the action is already applied. */
export interface Command {
  label: string;
  undo(): void;
  redo(): void;
}

export class History {
  private readonly undoStack: Command[] = [];
  private readonly redoStack: Command[] = [];
  onChange: (() => void) | null = null;

  constructor(private readonly limit = 200) {}

  push(cmd: Command): void {
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    this.onChange?.();
  }

  undo(): Command | null {
    const cmd = this.undoStack.pop();
    if (!cmd) return null;
    cmd.undo();
    this.redoStack.push(cmd);
    this.onChange?.();
    return cmd;
  }

  redo(): Command | null {
    const cmd = this.redoStack.pop();
    if (!cmd) return null;
    cmd.redo();
    this.undoStack.push(cmd);
    this.onChange?.();
    return cmd;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.onChange?.();
  }
}
