import type { LogEvent, Project } from '@evocut/edl';
import { LogEvent as LogEventSchema, Project as ProjectSchema } from '@evocut/edl';
import { fingerprintFile, mediaPath } from './fingerprint.js';
import type { MediaRecord, MediaStore, ProjectStore, ProjectSummary, Stores } from './types.js';

/**
 * In-memory stores.
 *
 * Not just a test double: OPFS has no Node equivalent, so without these the entire
 * persistence layer and everything built on it would only be exercisable in a browser.
 * They implement the same contracts, including the parts that are easy to get wrong —
 * fingerprint dedupe, event ordering, refusing to hand back a project that no longer
 * matches the schema.
 */
export class MemoryMediaStore implements MediaStore {
  #files = new Map<string, File>();
  #records = new Map<string, MediaRecord>();

  async put(file: File): Promise<MediaRecord> {
    const fingerprint = await fingerprintFile(file);
    const path = mediaPath(fingerprint);

    const existing = this.#records.get(fingerprint);
    if (existing && this.#files.has(path)) return existing;

    const record: MediaRecord = {
      fingerprint,
      path,
      filename: file.name,
      sizeBytes: file.size,
      ...(file.type ? { mimeType: file.type } : {}),
      importedAt: new Date().toISOString(),
    };
    this.#files.set(path, file);
    this.#records.set(fingerprint, record);
    return record;
  }

  async get(path: string): Promise<File | null> {
    return this.#files.get(path) ?? null;
  }

  async has(path: string): Promise<boolean> {
    return this.#files.has(path);
  }

  async delete(path: string): Promise<void> {
    this.#files.delete(path);
    for (const [fingerprint, record] of this.#records) {
      if (record.path === path) this.#records.delete(fingerprint);
    }
  }

  async list(): Promise<MediaRecord[]> {
    return [...this.#records.values()];
  }

  async usage(): Promise<number> {
    return [...this.#records.values()].reduce((total, record) => total + record.sizeBytes, 0);
  }
}

export class MemoryProjectStore implements ProjectStore {
  #projects = new Map<string, unknown>();
  #events = new Map<string, LogEvent[]>();
  #lastOpened: string | null = null;

  async save(project: Project): Promise<void> {
    // Round-tripped through JSON so the in-memory store cannot accidentally hand back a
    // live object reference that the real one never would.
    this.#projects.set(project.id, JSON.parse(JSON.stringify(project)));
  }

  async load(id: string): Promise<Project | null> {
    const raw = this.#projects.get(id);
    if (raw === undefined) return null;
    return ProjectSchema.parse(raw);
  }

  async list(): Promise<ProjectSummary[]> {
    return [...this.#projects.values()]
      .map((raw) => ProjectSchema.safeParse(raw))
      .filter((parsed) => parsed.success)
      .map(({ data: project }) => ({
        id: project.id,
        name: project.name,
        stage: project.stage,
        updatedAt: project.updatedAt,
        clipCount: project.timeline.tracks.flatMap((t) => t.clips).filter((c) => c.enabled).length,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async delete(id: string): Promise<void> {
    this.#projects.delete(id);
    this.#events.delete(id);
    if (this.#lastOpened === id) this.#lastOpened = null;
  }

  async appendEvents(events: LogEvent[]): Promise<void> {
    for (const event of events) {
      const existing = this.#events.get(event.projectId) ?? [];
      // Keyed by seq in the real store, so a repeat of the same seq overwrites rather
      // than duplicating. Mirror that here or a retry would look different in tests.
      const next = existing.filter((e) => e.seq !== event.seq);
      next.push(event);
      this.#events.set(event.projectId, next);
    }
  }

  async readEvents(projectId: string): Promise<LogEvent[]> {
    // Validated on read exactly as the IndexedDB store does. A double that is more
    // forgiving than the real thing is worse than no double: it lets a malformed event
    // pass the test suite and vanish in production.
    return [...(this.#events.get(projectId) ?? [])]
      .map((event) => LogEventSchema.safeParse(event))
      .filter((parsed) => parsed.success)
      .map((parsed) => parsed.data)
      .sort((a, b) => a.seq - b.seq);
  }

  async getLastOpened(): Promise<string | null> {
    return this.#lastOpened;
  }

  async setLastOpened(projectId: string | null): Promise<void> {
    this.#lastOpened = projectId;
  }
}

export function createMemoryStores(): Stores {
  return { media: new MemoryMediaStore(), projects: new MemoryProjectStore() };
}
