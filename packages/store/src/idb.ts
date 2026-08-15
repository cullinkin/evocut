import { LogEvent, Project } from '@evocut/edl';
import type { MediaIndex } from './opfs.js';
import type { LoadedProject, MediaRecord, ProjectStore, ProjectSummary } from './types.js';

export const DB_NAME = 'evocut';
export const DB_VERSION = 2;

const PROJECTS = 'projects';
const EVENTS = 'events';
const MEDIA = 'media';
const META = 'meta';
const BLOBS = 'blobs';

/**
 * Thrown when a stored project no longer matches the schema.
 *
 * Deliberately not "return null": a project that fails to parse is the user's work, and
 * reporting it as absent invites the app to overwrite it with a fresh one. The record is
 * left in the database so a future migration can still reach it.
 */
export class CorruptProjectError extends Error {
  readonly projectId: string;
  constructor(projectId: string, detail: string) {
    super(`Project ${projectId} could not be read: ${detail}`);
    this.name = 'CorruptProjectError';
    this.projectId = projectId;
  }
}

/**
 * One IndexedDB connection, shared by the stores that live in it.
 *
 * The projects, the log, and the media index are three different concerns but one
 * database — they have to be opened together or an upgrade in one would block the others.
 * Keeping the connection separate from the stores also means neither store class has to
 * carry an interface it does not implement.
 */
export class IdbConnection {
  #db: Promise<IDBDatabase> | null = null;
  #factory: IDBFactory;

  constructor(factory: IDBFactory = indexedDB) {
    this.#factory = factory;
  }

  static isSupported(): boolean {
    return typeof indexedDB !== 'undefined';
  }

  open(): Promise<IDBDatabase> {
    this.#db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.#factory.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(EVENTS)) {
          // Keyed by [projectId, seq] so an append is a put with a known key and the
          // log for one project is a single index range.
          const events = db.createObjectStore(EVENTS, { keyPath: ['projectId', 'seq'] });
          events.createIndex('byProject', 'projectId');
        }
        if (!db.objectStoreNames.contains(MEDIA)) db.createObjectStore(MEDIA, { keyPath: 'fingerprint' });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
        // Only used by `IdbMediaStore`, the fallback for browsers that cannot write to
        // OPFS. Created unconditionally so switching backends never needs an upgrade.
        if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, { keyPath: 'path' });
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Could not open the EvoCut database'));
      request.onblocked = () =>
        reject(new Error('The EvoCut database is open in another tab running an older version'));
    });
    return this.#db;
  }

  async run<T>(
    storeName: string,
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => IDBRequest,
  ): Promise<T> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const request = work(tx.objectStore(storeName));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error ?? new Error(`${storeName} request failed`));
      tx.onabort = () => reject(tx.error ?? new Error(`${storeName} transaction aborted`));
    });
  }

  async transact(
    storeName: string,
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => void,
  ): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      work(tx.objectStore(storeName));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error(`${storeName} transaction failed`));
      tx.onabort = () => reject(tx.error ?? new Error(`${storeName} transaction aborted`));
    });
  }
}

/**
 * Projects and their logs.
 *
 * Log events get their own object store rather than living inside the project document.
 * The log is append-only and grows with every scrub, so rewriting the whole project to add
 * one row would make logging quadratic — and logging has to stay cheap enough that nobody
 * is tempted to make it sparse.
 */
export class IdbProjectStore implements ProjectStore {
  #db: IdbConnection;

  constructor(connection: IdbConnection) {
    this.#db = connection;
  }

  async save(project: Project): Promise<void> {
    await this.#db.run(PROJECTS, 'readwrite', (store) => store.put(project));
  }

  async load(id: string): Promise<Project | null> {
    const raw = await this.#db.run<unknown>(PROJECTS, 'readonly', (store) => store.get(id));
    if (raw === undefined) return null;

    const parsed = Project.safeParse(raw);
    if (!parsed.success) throw new CorruptProjectError(id, parsed.error.message);
    return parsed.data;
  }

  async list(): Promise<ProjectSummary[]> {
    const raws = await this.#db.run<unknown[]>(PROJECTS, 'readonly', (store) => store.getAll());

    return raws
      .map((raw) => {
        // One unreadable project must not break the project list — that is the screen
        // the user needs in order to reach all the others.
        const parsed = Project.safeParse(raw);
        if (!parsed.success) return null;
        const project = parsed.data;
        return {
          id: project.id,
          name: project.name,
          stage: project.stage,
          updatedAt: project.updatedAt,
          clipCount: project.timeline.tracks.flatMap((t) => t.clips).filter((c) => c.enabled).length,
        } satisfies ProjectSummary;
      })
      .filter((summary): summary is ProjectSummary => summary !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async delete(id: string): Promise<void> {
    await this.#db.run(PROJECTS, 'readwrite', (store) => store.delete(id));
    await this.#deleteEvents(id);
    if ((await this.getLastOpened()) === id) await this.setLastOpened(null);
  }

  async appendEvents(events: LogEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.#db.transact(EVENTS, 'readwrite', (store) => {
      for (const event of events) store.put(event);
    });
  }

  async readEvents(projectId: string): Promise<LogEvent[]> {
    const raws = await this.#db.run<unknown[]>(EVENTS, 'readonly', (store) =>
      store.index('byProject').getAll(projectId),
    );

    // Same reasoning as `parseLog`: a row we cannot read costs that row, not the session.
    return raws
      .map((raw) => LogEvent.safeParse(raw))
      .filter((parsed) => parsed.success)
      .map((parsed) => parsed.data)
      .sort((a, b) => a.seq - b.seq);
  }

  async loadWithEvents(id: string): Promise<LoadedProject | null> {
    const project = await this.load(id);
    if (!project) return null;
    return { project, events: await this.readEvents(id) };
  }

  async getLastOpened(): Promise<string | null> {
    const row = await this.#db.run<{ key: string; value: string } | undefined>(META, 'readonly', (store) =>
      store.get('lastOpened'),
    );
    return row?.value ?? null;
  }

  async setLastOpened(projectId: string | null): Promise<void> {
    await this.#db.run(META, 'readwrite', (store) =>
      projectId === null ? store.delete('lastOpened') : store.put({ key: 'lastOpened', value: projectId }),
    );
  }

  async #deleteEvents(projectId: string): Promise<void> {
    await this.#db.transact(EVENTS, 'readwrite', (store) => {
      const request = store.index('byProject').openKeyCursor(projectId);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        store.delete(cursor.primaryKey);
        cursor.continue();
      };
    });
  }
}

/** The metadata half of the media store; the bytes live in OPFS. */
export class IdbMediaIndex implements MediaIndex {
  #db: IdbConnection;

  constructor(connection: IdbConnection) {
    this.#db = connection;
  }

  async get(fingerprint: string): Promise<MediaRecord | null> {
    return (
      (await this.#db.run<MediaRecord | undefined>(MEDIA, 'readonly', (s) => s.get(fingerprint))) ?? null
    );
  }

  async put(record: MediaRecord): Promise<void> {
    await this.#db.run(MEDIA, 'readwrite', (store) => store.put(record));
  }

  async delete(fingerprint: string): Promise<void> {
    await this.#db.run(MEDIA, 'readwrite', (store) => store.delete(fingerprint));
  }

  async list(): Promise<MediaRecord[]> {
    return this.#db.run<MediaRecord[]>(MEDIA, 'readonly', (store) => store.getAll());
  }
}
