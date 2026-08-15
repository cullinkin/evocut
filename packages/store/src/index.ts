import { IdbConnection, IdbMediaIndex, IdbProjectStore } from './idb.js';
import { OpfsMediaStore } from './opfs.js';
import { createMemoryStores } from './memory.js';
import type { Stores } from './types.js';

/**
 * `@evocut/store` — local persistence.
 *
 * Media goes to OPFS, everything else to IndexedDB. The split is about access pattern,
 * not taste: the renderer needs to stream a source lazily, which an OPFS file handle
 * supports and an IndexedDB blob does not, while projects and log rows need querying and
 * partial updates, which is the opposite.
 *
 * Nothing here leaves the device. Sync is a later problem, and the schema is ready for it
 * (`Source.locator` already has an `object` variant) but nothing implements it.
 */

export * from './types.js';
export * from './fingerprint.js';
export * from './bind.js';
export * from './memory.js';
export { OpfsMediaStore, type MediaIndex } from './opfs.js';
export { IdbConnection, IdbProjectStore, IdbMediaIndex, CorruptProjectError, DB_NAME, DB_VERSION } from './idb.js';

/** True when this browser can persist anything at all. */
export function isPersistenceSupported(): boolean {
  return OpfsMediaStore.isSupported() && IdbConnection.isSupported();
}

/**
 * The real stores, or in-memory ones when the browser cannot do better.
 *
 * Falling back rather than failing is deliberate: a private window with OPFS disabled
 * should still let someone try the coarse pass, just without keeping it. The app tells
 * them which mode they are in via the returned `persistent` flag.
 */
export function createStores(): Stores & { persistent: boolean } {
  if (!isPersistenceSupported()) {
    return { ...createMemoryStores(), persistent: false };
  }

  const connection = new IdbConnection();
  return {
    media: new OpfsMediaStore(new IdbMediaIndex(connection)),
    projects: new IdbProjectStore(connection),
    persistent: true,
  };
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
