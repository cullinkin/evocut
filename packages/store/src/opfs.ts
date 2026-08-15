import { fingerprintFile, mediaPath } from './fingerprint.js';
import type { MediaRecord, MediaStore } from './types.js';

/**
 * Media storage backed by the origin-private file system.
 *
 * OPFS rather than IndexedDB blobs because the renderer wants to *stream* a source, not
 * materialise a 500MB `ArrayBuffer` to seek inside it. An OPFS file handle gives a real
 * `File`, which `URL.createObjectURL` and (later) a WebCodecs demuxer can both read
 * lazily.
 *
 * The index of what is stored lives in IndexedDB alongside the projects, not in OPFS —
 * see `IdbProjectStore`. Keeping a directory listing as the source of truth would mean a
 * `readdir` on every import and no room for the metadata (original filename, mime type)
 * that OPFS itself does not keep.
 */
export class OpfsMediaStore implements MediaStore {
  #index: MediaIndex;
  #root: Promise<FileSystemDirectoryHandle> | null = null;

  constructor(index: MediaIndex) {
    this.#index = index;
  }

  /**
   * Feature-detected, not version-detected.
   *
   * `getDirectory` alone is not enough: iOS Safari exposed OPFS reads well before
   * `createWritable`, so a version check on "does OPFS exist" would report success on an
   * iPhone and then fail on the first import. Both halves have to be present.
   */
  static isSupported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      typeof navigator.storage?.getDirectory === 'function' &&
      typeof FileSystemFileHandle !== 'undefined' &&
      'createWritable' in FileSystemFileHandle.prototype
    );
  }

  async put(file: File): Promise<MediaRecord> {
    const fingerprint = await fingerprintFile(file);
    const path = mediaPath(fingerprint);

    const existing = await this.#index.get(fingerprint);
    // Re-importing the same recording is common (the picker forgets, the user retries),
    // and copying half a gigabyte again for it would be the slowest thing the app does.
    if (existing && (await this.has(path))) return existing;

    const handle = await this.#fileHandle(path, true);
    if (!handle) throw new Error(`Could not create ${path} in the origin-private file system`);

    const writable = await handle.createWritable();
    try {
      await file.stream().pipeTo(writable);
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }

    const record: MediaRecord = {
      fingerprint,
      path,
      filename: file.name,
      sizeBytes: file.size,
      ...(file.type ? { mimeType: file.type } : {}),
      importedAt: new Date().toISOString(),
    };
    await this.#index.put(record);
    return record;
  }

  async get(path: string): Promise<File | null> {
    const handle = await this.#fileHandle(path, false);
    if (!handle) return null;
    return handle.getFile();
  }

  async has(path: string): Promise<boolean> {
    return (await this.#fileHandle(path, false)) !== null;
  }

  async delete(path: string): Promise<void> {
    const [directory, name] = await this.#resolve(path, false);
    if (!directory) return;
    await directory.removeEntry(name).catch(() => {});
    const fingerprint = path.split('/').at(-1);
    if (fingerprint) await this.#index.delete(fingerprint);
  }

  async list(): Promise<MediaRecord[]> {
    return this.#index.list();
  }

  async usage(): Promise<number> {
    const records = await this.#index.list();
    return records.reduce((total, record) => total + record.sizeBytes, 0);
  }

  async #root_(): Promise<FileSystemDirectoryHandle> {
    this.#root ??= navigator.storage.getDirectory();
    return this.#root;
  }

  async #resolve(
    path: string,
    create: boolean,
  ): Promise<[FileSystemDirectoryHandle | null, string]> {
    const segments = path.split('/').filter(Boolean);
    const name = segments.pop();
    if (!name) throw new Error(`Invalid media path: ${path}`);

    let directory = await this.#root_();
    for (const segment of segments) {
      try {
        directory = await directory.getDirectoryHandle(segment, { create });
      } catch {
        return [null, name];
      }
    }
    return [directory, name];
  }

  async #fileHandle(path: string, create: boolean): Promise<FileSystemFileHandle | null> {
    const [directory, name] = await this.#resolve(path, create);
    if (!directory) return null;
    try {
      return await directory.getFileHandle(name, { create });
    } catch {
      return null;
    }
  }
}

/** The metadata side of the media store. Implemented by whatever owns IndexedDB. */
export interface MediaIndex {
  get(fingerprint: string): Promise<MediaRecord | null>;
  put(record: MediaRecord): Promise<void>;
  delete(fingerprint: string): Promise<void>;
  list(): Promise<MediaRecord[]>;
}
