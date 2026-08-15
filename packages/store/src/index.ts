import { IdbConnection, IdbMediaIndex, IdbProjectStore } from './idb.js';
import { IdbMediaStore } from './idb-media.js';
import { OpfsMediaStore } from './opfs.js';
import { createMemoryStores } from './memory.js';
import type { Stores } from './types.js';

/**
 * `@evocut/store` — local persistence.
 *
 * Media goes to OPFS where the browser can write to it, IndexedDB blobs where it cannot,
 * and everything else to IndexedDB either way. The OPFS preference is about access
 * pattern: the renderer needs to stream a source lazily, which an OPFS file handle
 * supports and an IndexedDB blob does not, while projects and log rows need querying and
 * partial updates, which is the opposite.
 *
 * Nothing here leaves the device. Sync is a later problem, and the schema is ready for it
 * (`Source.locator` already has an `object` variant) but nothing implements it.
 */

export * from './types.js';
export * from './fingerprint.js';
export * from './media-file.js';
export * from './bind.js';
export * from './memory.js';
export { OpfsMediaStore, type MediaIndex } from './opfs.js';
export { IdbMediaStore } from './idb-media.js';
export { IdbConnection, IdbProjectStore, IdbMediaIndex, CorruptProjectError, DB_NAME, DB_VERSION } from './idb.js';

/** How media is being stored, for the storage screen and for diagnosing a phone. */
export type MediaBackend = 'opfs' | 'indexeddb' | 'memory';

export interface AppStores extends Stores {
  persistent: boolean;
  backend: MediaBackend;
}

/**
 * The best stores this browser can manage.
 *
 * Degrading rather than failing is deliberate: a private window with storage disabled
 * should still let someone try the coarse pass, just without keeping it. The app tells
 * them which mode they are in via `persistent`.
 */
export function createStores(): AppStores {
  if (!IdbConnection.isSupported()) {
    return { ...createMemoryStores(), persistent: false, backend: 'memory' };
  }

  const connection = new IdbConnection();
  const index = new IdbMediaIndex(connection);
  const opfs = OpfsMediaStore.isSupported();

  return {
    media: opfs ? new OpfsMediaStore(index) : new IdbMediaStore(connection, index),
    projects: new IdbProjectStore(connection),
    persistent: true,
    backend: opfs ? 'opfs' : 'indexeddb',
  };
}

export function isPersistenceSupported(): boolean {
  return IdbConnection.isSupported();
}

/**
 * Ask the browser not to evict our data under storage pressure.
 *
 * Best-effort and usually granted only after the user has engaged with the site. Worth
 * calling after the first import, which is exactly when there is something to lose.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
