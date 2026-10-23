/** Resolves a relative URI referenced by a model file (buffers, textures, .mtl). */
export type ResourceResolver = (uri: string) => Promise<ArrayBuffer>;

export function urlResolver(baseUrl: string): ResourceResolver {
  return async (uri) => {
    const url = new URL(uri, new URL(baseUrl, window.location.href));
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url} (${res.status})`);
    return res.arrayBuffer();
  };
}

/** Resolves URIs against a set of user-selected / dropped files by file name. */
export function fileResolver(files: Iterable<File>): ResourceResolver {
  const byName = new Map<string, File>();
  for (const f of files) byName.set(f.name.toLowerCase(), f);
  return async (uri) => {
    if (uri.startsWith('data:')) return (await fetch(uri)).arrayBuffer();
    const name = decodeURIComponent(uri).split(/[\\/]/).pop()!.toLowerCase();
    const file = byName.get(name);
    if (!file) throw new Error(`Missing companion file "${name}". Select or drop it together with the model.`);
    return file.arrayBuffer();
  };
}

export function mimeFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'gif': return 'image/gif';
    case 'bmp': return 'image/bmp';
    default: return 'application/octet-stream';
  }
}

/** A file held in memory, as stored in a project asset. */
export interface MemoryFile {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
}

const fileNameOf = (uri: string) => decodeURIComponent(uri).split(/[\\/]/).pop()!.toLowerCase();

/** Resolves URIs against in-memory files by file name (like fileResolver). */
export function bytesResolver(files: Iterable<MemoryFile>): ResourceResolver {
  const byName = new Map<string, MemoryFile>();
  for (const f of files) byName.set(f.name.toLowerCase(), f);
  return async (uri) => {
    if (uri.startsWith('data:')) return (await fetch(uri)).arrayBuffer();
    const file = byName.get(fileNameOf(uri));
    if (!file) throw new Error(`Missing companion file "${fileNameOf(uri)}"`);
    return file.bytes.slice().buffer;
  };
}

/** Wraps a resolver to keep a copy of every external file it reads (data: URIs are part of the model file already). */
export function recordingResolver(resolve: ResourceResolver, read: MemoryFile[]): ResourceResolver {
  return async (uri) => {
    const data = await resolve(uri);
    const name = uri.startsWith('data:') ? null : decodeURIComponent(uri).split(/[\\/]/).pop()!;
    if (name && !read.some((f) => f.name.toLowerCase() === name.toLowerCase())) read.push({ name, bytes: new Uint8Array(data.slice(0)) });
    return data;
  };
}
