import { MemoryFolder, normalizePath, type FolderIO } from '../engine';

// Project folders in the browser: a FileSystemDirectoryHandle from the File System Access API (Chromium; also the
// origin-private file system the UI test uses), or, where that's missing, the files of a folder picked with
// <input webkitdirectory>, read once into memory.

// File System Access API pieces missing from lib.dom.
export type PermissionDirectory = FileSystemDirectoryHandle & {
  queryPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>;
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};
type PickerWindow = Window & { showDirectoryPicker?: (opts?: { mode?: 'readwrite'; id?: string }) => Promise<FileSystemDirectoryHandle> };

/** Whether this browser can open project folders read-write. */
export const canPickFolders = () => typeof (window as PickerWindow).showDirectoryPicker === 'function';

/** Asks the user for a folder. Throws an AbortError when they cancel. */
export function pickFolder(): Promise<FileSystemDirectoryHandle> {
  return (window as PickerWindow).showDirectoryPicker!({ mode: 'readwrite', id: 'messier-project' });
}

/**
 * Makes sure the page may read and write the folder. Without `ask` it only checks (a stored handle needs a click
 * before the browser lets the page ask again).
 */
export async function folderPermission(handle: FileSystemDirectoryHandle, ask: boolean): Promise<boolean> {
  const h = handle as PermissionDirectory;
  if (!h.queryPermission) return true;
  if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  return ask && (await h.requestPermission?.({ mode: 'readwrite' })) === 'granted';
}

export function handleFolder(root: FileSystemDirectoryHandle): FolderIO {
  const dir = async (path: string, create: boolean): Promise<FileSystemDirectoryHandle | null> => {
    let d = root;
    for (const part of normalizePath(path).split('/').filter(Boolean)) {
      try {
        d = await d.getDirectoryHandle(part, { create });
      } catch {
        return null;
      }
    }
    return d;
  };
  const split = (path: string) => {
    const p = normalizePath(path);
    const i = p.lastIndexOf('/');
    return { parent: i < 0 ? '' : p.slice(0, i), name: p.slice(i + 1) };
  };
  const file = async (path: string): Promise<File | null> => {
    const { parent, name } = split(path);
    const d = await dir(parent, false);
    try {
      return d ? await (await d.getFileHandle(name)).getFile() : null;
    } catch {
      return null;
    }
  };
  return {
    async list(path) {
      const d = await dir(path, false);
      if (!d) return [];
      const out: { name: string; kind: 'file' | 'directory' }[] = [];
      for await (const [name, h] of (d as PermissionDirectory).entries()) out.push({ name, kind: h.kind });
      return out;
    },
    async read(path) {
      const f = await file(path);
      if (!f) throw new Error(`${path} not found`);
      return new Uint8Array(await f.arrayBuffer());
    },
    async write(path, data) {
      const { parent, name } = split(path);
      const d = await dir(parent, true);
      if (!d) throw new Error(`Can't create the folder for ${path}`);
      const w = await (await d.getFileHandle(name, { create: true })).createWritable();
      await w.write(typeof data === 'string' ? data : new Uint8Array(data));
      await w.close();
    },
    async remove(path) {
      const { parent, name } = split(path);
      const d = await dir(parent, false);
      try {
        await d?.removeEntry(name, { recursive: true });
      } catch {
        // Already gone.
      }
    },
    async stat(path) {
      const f = await file(path);
      return f ? { size: f.size, modified: f.lastModified } : null;
    },
  };
}

/** The files of a folder picked with <input webkitdirectory>, without the folder's own name in their paths. */
export async function filesFolder(files: File[]): Promise<MemoryFolder> {
  const io = new MemoryFolder();
  for (const f of files) {
    const rel = (f.webkitRelativePath || f.name).split('/').slice(1).join('/');
    if (rel) await io.write(rel, new Uint8Array(await f.arrayBuffer()));
  }
  return io;
}
