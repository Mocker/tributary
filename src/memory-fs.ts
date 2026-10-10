/**
 * Minimal in-memory filesystem implementing the `fs.promises` surface that
 * isomorphic-git needs. For Cloudflare Workers (no disk, no IndexedDB).
 * Adapted from the MemoryFS in Cloudflare's official isomorphic-git +
 * Artifacts example.
 */
type DirEntry = { kind: 'dir'; children: Set<string>; mtimeMs: number };
type FileEntry = { kind: 'file'; data: Uint8Array; mtimeMs: number };
type Entry = DirEntry | FileEntry;

function fsError(code: string, path: string): Error {
  const e = new Error(`${code}: ${path}`) as Error & { code: string };
  e.code = code;
  return e;
}

class MemoryStats {
  constructor(private entry: Entry) {}
  get size(): number {
    return this.entry.kind === 'file' ? this.entry.data.byteLength : 0;
  }
  get mtimeMs(): number {
    return this.entry.mtimeMs;
  }
  get ctimeMs(): number {
    return this.entry.mtimeMs;
  }
  get mode(): number {
    return this.entry.kind === 'file' ? 0o100644 : 0o040000;
  }
  isFile(): boolean {
    return this.entry.kind === 'file';
  }
  isDirectory(): boolean {
    return this.entry.kind === 'dir';
  }
  isSymbolicLink(): boolean {
    return false;
  }
}

export class MemoryFS {
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();
  private entries = new Map<string, Entry>([
    ['/', { kind: 'dir', children: new Set(), mtimeMs: Date.now() }],
  ]);

  promises = {
    readFile: this.readFile.bind(this),
    writeFile: this.writeFile.bind(this),
    unlink: this.unlink.bind(this),
    readdir: this.readdir.bind(this),
    mkdir: this.mkdir.bind(this),
    rmdir: this.rmdir.bind(this),
    rm: this.rm.bind(this),
    stat: this.stat.bind(this),
    lstat: this.lstat.bind(this),
    readlink: this.readlink.bind(this),
    symlink: this.symlink.bind(this),
  };

  private normalize(input: string): string {
    const segments: string[] = [];
    for (const part of input.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        segments.pop();
        continue;
      }
      segments.push(part);
    }
    return `/${segments.join('/')}` || '/';
  }

  private parent(path: string): string {
    const normalized = this.normalize(path);
    if (normalized === '/') return '/';
    const parts = normalized.split('/').filter(Boolean);
    parts.pop();
    return parts.length ? `/${parts.join('/')}` : '/';
  }

  private basename(path: string): string {
    return this.normalize(path).split('/').filter(Boolean).pop() ?? '';
  }

  private getEntry(path: string): Entry | undefined {
    return this.entries.get(this.normalize(path));
  }

  private requireEntry(path: string): Entry {
    const entry = this.getEntry(path);
    if (!entry) throw fsError('ENOENT', path);
    return entry;
  }

  private requireDir(path: string): DirEntry {
    const entry = this.requireEntry(path);
    if (entry.kind !== 'dir') throw fsError('ENOTDIR', path);
    return entry;
  }

  private async mkdir(
    path: string,
    options?: { recursive?: boolean } | boolean
  ): Promise<void> {
    const target = this.normalize(path);
    if (target === '/') return;
    const recursive =
      typeof options === 'object' && options !== null && options.recursive;
    const parent = this.parent(target);
    if (!this.entries.has(parent)) {
      if (!recursive) throw fsError('ENOENT', parent);
      await this.mkdir(parent, { recursive: true });
    }
    if (this.entries.has(target)) return;
    this.entries.set(target, {
      kind: 'dir',
      children: new Set(),
      mtimeMs: Date.now(),
    });
    this.requireDir(parent).children.add(this.basename(target));
  }

  private async writeFile(
    path: string,
    data: string | Uint8Array | ArrayBuffer
  ): Promise<void> {
    const target = this.normalize(path);
    await this.mkdir(this.parent(target), { recursive: true });
    const bytes =
      typeof data === 'string'
        ? this.encoder.encode(data)
        : data instanceof Uint8Array
          ? data
          : new Uint8Array(data);
    this.entries.set(target, {
      kind: 'file',
      data: bytes,
      mtimeMs: Date.now(),
    });
    this.requireDir(this.parent(target)).children.add(this.basename(target));
  }

  private async readFile(
    path: string,
    options?: string | { encoding?: string }
  ): Promise<Uint8Array | string> {
    const entry = this.requireEntry(path);
    if (entry.kind !== 'file') throw fsError('EISDIR', path);
    const encoding =
      typeof options === 'string' ? options : options?.encoding;
    return encoding ? this.decoder.decode(entry.data) : entry.data;
  }

  private async readdir(path: string): Promise<string[]> {
    return [...this.requireDir(path).children].sort();
  }

  private async unlink(path: string): Promise<void> {
    const target = this.normalize(path);
    const entry = this.requireEntry(target);
    if (entry.kind !== 'file') throw fsError('EISDIR', path);
    this.entries.delete(target);
    this.requireDir(this.parent(target)).children.delete(
      this.basename(target)
    );
  }

  private async rmdir(path: string): Promise<void> {
    const target = this.normalize(path);
    const entry = this.requireDir(target);
    if (entry.children.size > 0) throw fsError('ENOTEMPTY', path);
    this.entries.delete(target);
    this.requireDir(this.parent(target)).children.delete(
      this.basename(target)
    );
  }

  private async rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ): Promise<void> {
    const target = this.normalize(path);
    const entry = this.entries.get(target);
    if (!entry) {
      if (options?.force) return;
      throw fsError('ENOENT', path);
    }
    if (entry.kind === 'dir') {
      if (!options?.recursive) throw fsError('EISDIR', path);
      for (const child of [...entry.children]) {
        await this.rm(`${target}/${child}`, { recursive: true });
      }
      this.entries.delete(target);
      if (target !== '/') {
        this.requireDir(this.parent(target)).children.delete(
          this.basename(target)
        );
      }
      return;
    }
    await this.unlink(target);
  }

  private async readlink(path: string): Promise<string> {
    // No symlinks in MemoryFS (isSymbolicLink() is always false, so
    // isomorphic-git never calls this on a real entry).
    throw fsError('EINVAL', path);
  }

  private async symlink(_target: string, _path: string): Promise<void> {
    // Symlinks are not supported in MemoryFS.
    throw fsError('ENOSYS', _path);
  }

  private async stat(path: string): Promise<MemoryStats> {
    return new MemoryStats(this.requireEntry(path));
  }

  private async lstat(path: string): Promise<MemoryStats> {
    return this.stat(path);
  }
}
