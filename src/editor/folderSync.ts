import { diffSnapshots, snapshotFolder, type FolderIO, type FolderSnapshot } from '../engine';

export interface FolderChanges {
  added: string[];
  changed: string[];
  removed: string[];
}

// Notices files added, changed or removed in a project folder by something other than the editor (a file manager,
// VS Code). Browsers have no general file watching: where FileSystemObserver exists it triggers a scan right away,
// and a scan also runs every POLL_MS. A scan compares sizes and modification times with the last snapshot; the
// editor reports its own writes with noteWrite() so they don't come back as changes.

const POLL_MS = 1000;

type ObserverCtor = new (cb: () => void) => { observe(h: FileSystemHandle, o: { recursive: boolean }): Promise<void>; disconnect(): void };

export class FolderSync {
  private snapshot: FolderSnapshot = new Map();
  private timer = 0;
  private observer: InstanceType<ObserverCtor> | null = null;
  private scanning: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(
    private readonly io: FolderIO,
    /** Called with each batch of outside changes, one batch at a time. */
    private readonly onChanges: (changes: FolderChanges) => Promise<void>,
  ) {}

  /** Takes the first snapshot and starts watching. */
  async start(handle?: FileSystemDirectoryHandle): Promise<void> {
    this.snapshot = await snapshotFolder(this.io);
    this.timer = window.setInterval(() => void this.scan(), POLL_MS);
    const Observer = (window as unknown as { FileSystemObserver?: ObserverCtor }).FileSystemObserver;
    if (Observer && handle) {
      try {
        this.observer = new Observer(() => void this.scan());
        await this.observer.observe(handle, { recursive: true });
      } catch {
        this.observer = null; // polling still runs
      }
    }
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.observer?.disconnect();
  }

  /** Looks for changes now. Concurrent calls share one scan (and one more runs after it if asked for meanwhile). */
  scan(): Promise<void> {
    if (this.scanning) {
      this.again = true;
      return this.scanning;
    }
    this.scanning = (async () => {
      do {
        this.again = false;
        if (this.stopped) return;
        const next = await snapshotFolder(this.io);
        const changes = diffSnapshots(this.snapshot, next);
        this.snapshot = next;
        if (changes.added.length || changes.changed.length || changes.removed.length) await this.onChanges(changes);
      } while (this.again);
    })().finally(() => (this.scanning = null));
    return this.scanning;
  }

  /** Records a file the editor wrote (or removed), so the next scan doesn't report it. */
  async noteWrite(path: string): Promise<void> {
    const st = await this.io.stat(path);
    if (st) this.snapshot.set(path, `${st.size}:${st.modified}`);
    else this.snapshot.delete(path);
  }
}
