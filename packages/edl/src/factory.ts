import { newId as defaultNewId, type EntityKind, type Provenance } from './schema/common.js';
import type { Clip } from './schema/clip.js';
import type { Source } from './schema/source.js';
import type { Timeline, Track, TrackKind } from './schema/timeline.js';
import { Project, SCHEMA_VERSION, type OpVerdict, type Revision } from './schema/project.js';
import type { Op } from './schema/ops.js';
import { normalizeTimeline } from './normalize.js';
import { applyOps, type ApplyContext, type ApplyResult } from './apply.js';
import { FPS_30, type Rational } from './time.js';

/**
 * Constructors.
 *
 * Every one takes injectable `newId` and `now`, because two things in this system have to
 * be reproducible: tests, and replaying a log back into the timeline it produced. Reaching
 * for `Date.now()` inside a factory quietly forfeits both.
 */
export interface FactoryDeps {
  newId?: (kind: EntityKind) => string;
  now?: () => string;
}

function deps(d: FactoryDeps = {}) {
  return {
    newId: d.newId ?? defaultNewId,
    now: d.now ?? (() => new Date().toISOString()),
  };
}

export interface CreateTrackInit {
  kind?: TrackKind;
  name?: string;
  clips?: Clip[];
}

export function createTrack(init: CreateTrackInit = {}, d: FactoryDeps = {}): Track {
  const { newId } = deps(d);
  return {
    id: newId('track'),
    kind: init.kind ?? 'video',
    ...(init.name !== undefined ? { name: init.name } : {}),
    clips: init.clips ?? [],
    muted: false,
    locked: false,
  };
}

export interface CreateTimelineInit {
  frameRate?: Rational;
  resolution?: { width: number; height: number };
  tracks?: Track[];
}

export function createTimeline(init: CreateTimelineInit = {}, d: FactoryDeps = {}): Timeline {
  const { newId } = deps(d);
  // Normalized on the way out. `createClip` has no way to know where a clip will land, so
  // it emits `start: 0`; a constructor that handed back a pile of clips all starting at
  // zero would be a trap for every caller that did not know to reflow.
  return normalizeTimeline({
    id: newId('timeline'),
    frameRate: init.frameRate ?? FPS_30,
    // Portrait by default: the coarse pass happens on a phone, on phone footage.
    resolution: init.resolution ?? { width: 1080, height: 1920 },
    tracks: init.tracks ?? [createTrack({ kind: 'video', name: 'Video' }, d)],
    background: '#000000',
  });
}

export interface CreateClipInit {
  sourceId: string;
  sourceIn: number;
  sourceOut: number;
  speed?: number;
  label?: string;
  origin?: Provenance;
}

export function createClip(init: CreateClipInit, d: FactoryDeps = {}): Clip {
  const { newId } = deps(d);
  return {
    id: newId('clip'),
    sourceId: init.sourceId,
    sourceIn: init.sourceIn,
    sourceOut: init.sourceOut,
    start: 0,
    speed: init.speed ?? 1,
    enabled: true,
    audio: { gain: 1, mute: false },
    effects: [],
    ...(init.label !== undefined ? { label: init.label } : {}),
    ...(init.origin !== undefined ? { origin: init.origin } : {}),
  };
}

export interface CreateProjectInit {
  name?: string;
  sources?: Source[];
  timeline?: Timeline;
}

export function createProject(init: CreateProjectInit = {}, d: FactoryDeps = {}): Project {
  const { newId, now } = deps(d);
  const at = now();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newId('project'),
    name: init.name ?? 'Untitled',
    createdAt: at,
    updatedAt: at,
    sources: init.sources ?? [],
    timeline: normalizeTimeline(init.timeline ?? createTimeline({}, d)),
    stage: 'coarse',
    revisions: [],
  };
}

/**
 * Start a project from a single imported recording, with the whole thing on the timeline.
 *
 * This is the actual entry point of the product: you open the app, pick a video, and the
 * coarse pass begins with one clip covering everything. Every subsequent human action is a
 * subtraction from here.
 */
export function projectFromSource(source: Source, init: CreateProjectInit = {}, d: FactoryDeps = {}): Project {
  const clip = createClip(
    { sourceId: source.id, sourceIn: 0, sourceOut: source.duration, origin: { by: 'import' } },
    d,
  );
  const timeline = createTimeline(
    {
      ...(source.video
        ? {
            frameRate: source.video.frameRate,
            resolution: orientedResolution(source),
          }
        : {}),
      tracks: [createTrack({ kind: 'video', name: 'Video', clips: [clip] }, d)],
    },
    d,
  );

  return createProject({ name: source.name ?? 'Untitled', ...init, sources: [source], timeline }, d);
}

/** Container rotation is metadata, not pixels: a 90°-rotated 1920x1080 displays as portrait. */
function orientedResolution(source: Source): { width: number; height: number } {
  const video = source.video!;
  const turned = video.rotation === 90 || video.rotation === 270;
  return turned
    ? { width: video.height, height: video.width }
    : { width: video.width, height: video.height };
}

export interface CommitOptions extends ApplyContext, FactoryDeps {
  by: Revision['by'];
  summary?: string;
  model?: string;
  /**
   * Per-op verdicts from a review screen. Pass the *whole* proposal here — including the
   * ops the user rejected — while `ops` carries only the accepted subset. The rejected
   * ones leave no mark on the timeline, so this is the only place they survive.
   */
  review?: { verdicts: OpVerdict[]; reviewedAt?: string };
}

export interface CommitResult extends ApplyResult {
  project: Project;
  revision: Revision;
}

/**
 * Apply ops to a project and record them as a revision.
 *
 * The revision is written even when some ops failed — it records what was *applied*, so
 * replaying the chain reproduces the timeline exactly. The failures come back in
 * `errors` for the caller to feed into a repair round.
 */
export function commitOps(project: Project, ops: Op[], options: CommitOptions): CommitResult {
  const { newId, now } = deps(options);
  const result = applyOps(project.timeline, ops, { sources: project.sources, ...options });

  const at = now();
  const review = options.review
    ? { verdicts: options.review.verdicts, reviewedAt: options.review.reviewedAt ?? at }
    : undefined;

  const revision: Revision = {
    id: newId('revision'),
    ...(project.headRevisionId ? { parentId: project.headRevisionId } : {}),
    at,
    by: options.by,
    ops: result.applied,
    ...(options.summary !== undefined ? { summary: options.summary } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(review
      ? {
          review,
          // "The human kept something from this pass." A pass where every op was waved
          // away is a rejected pass, and that is the label a training export wants.
          accepted: review.verdicts.some((v) => v.accepted),
        }
      : {}),
  };

  return {
    ...result,
    revision,
    project: {
      ...project,
      timeline: result.timeline,
      revisions: [...project.revisions, revision],
      headRevisionId: revision.id,
      updatedAt: revision.at,
    },
  };
}

/**
 * Freeze the coarse pass and hand the project to the refinement stage.
 *
 * The snapshot taken here is the training artefact. Once refinement ops land on the live
 * timeline there is no way to recover which cuts were the human's, so this is the one
 * moment it can be captured.
 */
export function freezeCoarsePass(project: Project, d: FactoryDeps = {}): Project {
  const { now } = deps(d);
  return {
    ...project,
    stage: 'handoff',
    coarseSnapshot: structuredClone(project.timeline),
    coarseSnapshotAt: now(),
    updatedAt: now(),
  };
}
