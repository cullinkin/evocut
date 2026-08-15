import { fingerprintFile, mediaPath } from './fingerprint.js';
import { mimeOf, restoreFile } from './media-file.js';
import type { IdbConnection } from './idb.js';
import type { MediaIndex } from './opfs.js';
import type { MediaRecord, MediaStore } from './types.js';

const BLOBS = 'blobs';

/**
 * Media storage in IndexedDB, for browsers whose OPFS cannot be written to.
 *
 * iOS Safari shipped OPFS reads well before `createWritable`, so on an iPhone running an
 * older Safari the origin-private file system exists, reports itself supported, and then
 * fails on the first import. Falling back to IndexedDB blobs keeps the app working there.
 *
 * The cost is real and worth stating: reading a blob out of IndexedDB materialises the
 * whole file in memory, where an OPFS handle can be streamed. That is survivable for the
 * coarse pass — a `blob:` URL for a `<video>` element is all we need — but the renderer
 * will want the OPFS path when it lands, so this stays the fallback rather than the
 * default.
 */
export class IdbMediaStore implements MediaStore {
  #db: IdbConnection;
  #index: MediaIndex;

  constructor(connection: IdbConnection, index: MediaIndex) {
    this.#db = connection;
    this.#index = index;
  }

  async put(file: File): Promise<MediaRecord> {
    const fingerprint = await fingerprintFile(file);
    const path = mediaPath(fingerprint);

    const existing = await this.#index.get(fingerprint);
    if (existing && (await this.has(path))) return existing;

    const mime = mimeOf(file);
    await this.#db.run(BLOBS, 'readwrite', (store) =>
      store.put({ path, blob: file, filename: file.name, type: mime.mimeType ?? '' }),
    );

    const record: MediaRecord = {
      fingerprint,
      path,
      filename: file.name,
      sizeBytes: file.size,
      ...mime,
      importedAt: new Date().toISOString(),
    };
    await this.#index.put(record);
    return record;
  }

  async get(path: string): Promise<File | null> {
    const row = await this.#db.run<{ blob: Blob; filename: string; type: string } | undefined>(
      BLOBS,
      'readonly',
      (store) => store.get(path),
    );
    if (!row) return null;
    // Stored as a Blob; the app wants a File so the rest of the pipeline is uniform.
    return restoreFile(row.blob, { filename: row.filename, mimeType: row.type });
  }

  async has(path: string): Promise<boolean> {
    const key = await this.#db.run<IDBValidKey | undefined>(BLOBS, 'readonly', (store) =>
      store.getKey(path),
    );
    return key !== undefined;
  }

  async delete(path: string): Promise<void> {
    await this.#db.run(BLOBS, 'readwrite', (store) => store.delete(path));
    const fingerprint = path.split('/').at(-1);
    if (fingerprint) await this.#index.delete(fingerprint);
  }

  async list(): Promise<MediaRecord[]> {
    return this.#index.list();
  }

  async usage(): Promise<number> {
    return (await this.#index.list()).reduce((total, record) => total + record.sizeBytes, 0);
  }
}

export const BLOB_STORE = BLOBS;
