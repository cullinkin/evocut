import { fingerprintFile, mediaPath } from './fingerprint.js';
import { fingerprintFromPath, mimeOf, restoreFile } from './media-file.js';
import type { MediaRecord, MediaSink, MediaStore } from './types.js';

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
      ...mimeOf(file),
      importedAt: new Date().toISOString(),
    };
    await this.#index.put(record);
    return record;
  }

  async get(path: string): Promise<File | null> {
    const handle = await this.#fileHandle(path, false);
    if (!handle) return null;

    const bytes = await handle.getFile();
    // OPFS names a file after its path, and media paths carry no extension, so what
    // comes back is called `000002eeec…` with `type: ""`. Safari will not decode an
    // untyped blob URL, so the identity recorded at import is reapplied here.
    const fingerprint = fingerprintFromPath(path);
    const record = fingerprint ? await this.#index.get(fingerprint) : null;
    return record ? restoreFile(bytes, record) : bytes;
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

  /**
   * Stream bytes into a path, without ever holding the file.
   *
   * `createWritable` gives a random-access stream, which is what makes the one backwards
   * write the muxer needs possible — an `mdat` whose length is not known until the last
   * sample has gone past. See `Mp4Stream`.
   */
  async openWrite(path: string): Promise<MediaSink | null> {
    const handle = await this.#fileHandle(path, true);
    if (!handle) return null;

    const writable = await handle.createWritable().catch(() => null);
    if (!writable) return null;

    let at = 0;
    return {
      async write(bytes) {
        await writable.write({ type: 'write', position: at, data: bytes as unknown as BufferSource });
        at += bytes.byteLength;
      },
      async patch(position, bytes) {
        await writable.write({ type: 'write', position, data: bytes as unknown as BufferSource });
      },
      async close() {
        await writable.close();
        return at;
      },
      abort: async () => {
        await writable.abort().catch(() => {});
        // Nothing half-written is worth keeping: a truncated proxy is a file the editor
        // would try to play.
        await this.delete(path).catch(() => {});
      },
    };
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
