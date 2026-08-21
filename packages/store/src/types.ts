import type { LogEvent, Project } from '@evocut/edl';

/**
 * Storage interfaces.
 *
 * Two implementations exist: a browser one (OPFS + IndexedDB) and an in-memory one for
 * tests. The split is not ceremony — OPFS has no Node equivalent, so without an interface
 * every consumer of persistence would be untestable outside a browser.
 */

/** Identity of a picked file. See `fingerprintFile` for what this is and is not. */
export type MediaFingerprint = string;

export interface MediaRecord {
  fingerprint: MediaFingerprint;
  /** Path within the media store. Mirrors `Source.locator` for `kind: 'opfs'`. */
  path: string;
  filename: string;
  sizeBytes: number;
  mimeType?: string;
  importedAt: string;
}

/**
 * Somewhere to put a file that is too big to hold in memory.
 *
 * The proxy is the reason this exists: it covers a whole recording, which for the session
 * this was built for is twenty-seven minutes and several hundred megabytes. Assembling
 * that as a `Blob` on a phone, while a decoder and an encoder are both running, is how a
 * tab gets killed.
 */
export interface MediaSink {
  /** Append. */
  write(bytes: Uint8Array): Promise<void>;
  /** Overwrite bytes already written. Needed once, to close a box whose length was unknown. */
  patch(position: number, bytes: Uint8Array): Promise<void>;
  /** Commit, and say how big it came out. */
  close(): Promise<number>;
  /** Give up, leaving nothing behind. */
  abort(): Promise<void>;
}

export interface MediaStore {
  /**
   * Copy a picked file into storage, or return the existing record if its fingerprint is
   * already known. Idempotent: importing the same recording twice costs one copy.
   */
  put(file: File): Promise<MediaRecord>;
  /** Retrieve the bytes for a stored path. `null` when the media is gone. */
  get(path: string): Promise<File | null>;
  has(path: string): Promise<boolean>;
  delete(path: string): Promise<void>;
  list(): Promise<MediaRecord[]>;
  /** Total bytes held, for the storage screen. */
  usage(): Promise<number>;
  /**
   * Stream bytes into a stored path.
   *
   * Null where the backend cannot do it — the IndexedDB fallback holds blobs whole, and a
   * proxy is exactly the thing that must not be held whole, so there it is better to have
   * no proxy than a crash.
   */
  openWrite(path: string): Promise<MediaSink | null>;
}

export interface ProjectSummary {
  id: string;
  name: string;
  stage: Project['stage'];
  updatedAt: string;
  clipCount: number;
}

export interface LoadedProject {
  project: Project;
  /** Events replayed from storage, ordered by `seq`. */
  events: LogEvent[];
}

export interface ProjectStore {
  save(project: Project): Promise<void>;
  load(id: string): Promise<Project | null>;
  list(): Promise<ProjectSummary[]>;
  delete(id: string): Promise<void>;

  /** Append log events. Called on every logged action, so it must be cheap. */
  appendEvents(events: LogEvent[]): Promise<void>;
  readEvents(projectId: string): Promise<LogEvent[]>;

  /** Which project the app should reopen on launch. */
  getLastOpened(): Promise<string | null>;
  setLastOpened(projectId: string | null): Promise<void>;
}

/**
 * Somewhere to keep work that was derived from media rather than done by a person.
 *
 * Everything in here is disposable: it can always be recomputed from the source, so a
 * miss costs time and never costs work. That is what separates it from the project store,
 * where a lost record is a lost edit.
 */
export interface DerivedCache {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Small values the user set deliberately.
 *
 * Distinct from `DerivedCache` in exactly one way that matters: nothing here can be
 * recomputed. An API key, a model choice, a style brief — losing one costs the user
 * something, so this is storage, not cache.
 *
 * It is also the least secure thing in the app, and the app says so where the key is
 * entered: a browser's storage is readable by anything that can run script on the page.
 */
export interface SettingsStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Stores {
  media: MediaStore;
  projects: ProjectStore;
  derived: DerivedCache;
  settings: SettingsStore;
}

/**
 * A stored project whose media could not be found.
 *
 * Not an error: the user may have cleared site data, or opened the project on another
 * device. The app needs to ask them to re-pick the file, and needs to know *which* file,
 * which is why the source's name and duration are carried through.
 */
export interface MissingMedia {
  sourceId: string;
  filename: string;
  durationUs: number;
}
