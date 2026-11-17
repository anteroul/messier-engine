import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FolderIO } from '@root/src/engine/projectFolder.ts';

/** A project folder on disk, for tests (scripts/example-project.mjs has the same). */
export function nodeFolder(root: string): FolderIO {
  const at = (p: string) => join(root, p);
  return {
    async list(dir) {
      try {
        return readdirSync(at(dir), { withFileTypes: true }).map((e) => ({ name: e.name, kind: e.isDirectory() ? 'directory' : 'file' }));
      } catch {
        return [];
      }
    },
    async read(path) {
      const b = readFileSync(at(path));
      return new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    },
    async write(path, data) {
      mkdirSync(dirname(at(path)), { recursive: true });
      writeFileSync(at(path), data);
    },
    async remove(path) {
      rmSync(at(path), { recursive: true, force: true });
    },
    async stat(path) {
      try {
        const s = statSync(at(path));
        return s.isFile() ? { size: s.size, modified: s.mtimeMs } : null;
      } catch {
        return null;
      }
    },
  };
}
