import type { Project, Source } from '@evocut/edl';
import type { MediaStore, MissingMedia } from './types.js';

/**
 * Re-attaching a saved project to real bytes.
 *
 * The EDL stores a *locator hint*, not a file. Reopening a project therefore has a step
 * that a desktop editor does not: find the media again, and cope with not finding it. The
 * cut points are valid either way — the timeline is meaningful without the footage — so
 * "media missing" is a state to render, not an error to throw.
 */
export interface BoundMedia {
  /** Object URLs by source id, for the player. The caller owns revoking these. */
  urls: Map<string, string>;
  /** Sources whose bytes are gone. The app asks the user to re-pick these. */
  missing: MissingMedia[];
}

export interface BindOptions {
  /**
   * How a stored file becomes a URL the player can use.
   *
   * Injected rather than fixed at `URL.createObjectURL`, because that is the one thing
   * iOS Safari cannot seek inside — the app serves media through a range-answering
   * service worker instead, and this package has no business knowing about it.
   */
  createUrl?(file: File, source: Source): string;
}

export async function bindProjectMedia(
  project: Project,
  media: MediaStore,
  options: BindOptions = {},
): Promise<BoundMedia> {
  const createUrl = options.createUrl ?? ((file: File) => URL.createObjectURL(file));
  const urls = new Map<string, string>();
  const missing: MissingMedia[] = [];

  for (const source of project.sources) {
    const file = await openSource(source, media);
    if (file) {
      urls.set(source.id, createUrl(file, source));
    } else {
      missing.push({
        sourceId: source.id,
        filename: source.name ?? locatorFilename(source) ?? source.id,
        durationUs: source.duration,
      });
    }
  }

  return { urls, missing };
}

async function openSource(source: Source, media: MediaStore): Promise<File | null> {
  switch (source.locator.kind) {
    case 'opfs':
      return media.get(source.locator.path);
    case 'url':
    case 'object':
      // Remote media is not fetched here: that is a network decision the app should make
      // deliberately, not something a project load does on its own.
      return null;
    case 'unresolved':
      return null;
  }
}

function locatorFilename(source: Source): string | null {
  return source.locator.kind === 'unresolved' ? source.locator.filename : null;
}

/**
 * Point a source at newly stored media.
 *
 * Used twice: on import, to upgrade the `unresolved` locator that `probeVideoFile`
 * produces into a real OPFS path, and on re-pick, to reattach a project whose media went
 * missing. The source keeps its id, so every clip on the timeline stays valid.
 */
export function rebindSource(project: Project, sourceId: string, path: string, fingerprint: string): Project {
  return {
    ...project,
    sources: project.sources.map((source) =>
      source.id === sourceId
        ? { ...source, locator: { kind: 'opfs' as const, path }, contentHash: fingerprint }
        : source,
    ),
  };
}

/** Media referenced by no project. The storage screen offers to reclaim these. */
export async function orphanedMedia(projects: Project[], media: MediaStore): Promise<string[]> {
  const referenced = new Set(
    projects.flatMap((project) =>
      project.sources
        .filter((source) => source.locator.kind === 'opfs')
        .map((source) => (source.locator as { path: string }).path),
    ),
  );

  return (await media.list()).map((record) => record.path).filter((path) => !referenced.has(path));
}
