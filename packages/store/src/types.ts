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

export interface Stores {
  media: MediaStore;
  projects: ProjectStore;
  derived: DerivedCache;
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
