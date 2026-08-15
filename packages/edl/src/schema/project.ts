import { z } from 'zod';
import { Actor, ProjectId, RevisionId, Timestamp } from './common.js';
import { Source } from './source.js';
import { Timeline } from './timeline.js';
import { Op } from './ops.js';

/** Bump on any breaking change to the shape. Loaders migrate forward; see `migrate.ts`. */
export const SCHEMA_VERSION = 1;

/**
 * Where a project sits in the two-pass flow.
 *
 *   coarse    — human is selecting keepers on their phone. The only pass that produces
 *               training-grade signal, because nothing has been machine-suggested yet.
 *   handoff   — coarse pass frozen, refinement requested.
 *   refining  — a model pass is in flight or its ops are awaiting review.
 *   refined   — refinements accepted; ready to render.
 *   rendered  — an output exists for the current head revision.
 */
export const ProjectStage = z.enum(['coarse', 'handoff', 'refining', 'refined', 'rendered']);
export type ProjectStage = z.infer<typeof ProjectStage>;

/**
 * One applied batch of edits.
 *
 * Revisions form a linear chain (`parentId`), so the timeline at any point is replayable
 * from the initial import plus ops. That replayability is what makes the training export
 * trustworthy: we are not trusting a snapshot, we can re-derive it.
 */
export const Revision = z.object({
  id: RevisionId,
  parentId: RevisionId.optional(),
  at: Timestamp,
  by: Actor,
  /** Ops that take the parent revision's timeline to this one. */
  ops: z.array(Op),
  /** Model's summary of the pass, or a human note. */
  summary: z.string().max(4000).optional(),
  /** Model identifier, when `by === 'llm'`. */
  model: z.string().max(200).optional(),
  /**
   * Set when a human reviewed a model pass. `null`/absent means not yet reviewed.
   * This field is the accept/reject label in the training set — the whole point of
   * routing refinements through a review screen.
   */
  accepted: z.boolean().optional(),
});
export type Revision = z.infer<typeof Revision>;

export const RenderPreset = z.object({
  container: z.enum(['mp4', 'webm']).default('mp4'),
  videoCodec: z.string().default('avc1.640028'),
  audioCodec: z.string().default('mp4a.40.2'),
  videoBitrate: z.number().int().positive().default(8_000_000),
  audioBitrate: z.number().int().positive().default(128_000),
});
export type RenderPreset = z.infer<typeof RenderPreset>;

export const Project = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: ProjectId,
  name: z.string().max(500).default('Untitled'),
  createdAt: Timestamp,
  updatedAt: Timestamp,

  sources: z.array(Source),
  /** The live timeline: the result of applying every revision in order. */
  timeline: Timeline,

  stage: ProjectStage.default('coarse'),

  /**
   * The human's coarse pass, frozen at handoff.
   *
   * Kept alongside the live timeline rather than reconstructed from revisions, because
   * this is the artefact the whole training-set idea rests on and it must survive log
   * truncation, partial syncs, and any future compaction of `revisions`.
   */
  coarseSnapshot: Timeline.optional(),
  coarseSnapshotAt: Timestamp.optional(),

  revisions: z.array(Revision).default([]),
  /** Id of the last applied revision. `timeline` is the state as of this revision. */
  headRevisionId: RevisionId.optional(),

  render: RenderPreset.optional(),
  /** Free-form app state that should travel with the project but has no schema yet. */
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type Project = z.infer<typeof Project>;

export function findSource(project: Project, sourceId: string): Source | null {
  return project.sources.find((s) => s.id === sourceId) ?? null;
}

export function headRevision(project: Project): Revision | null {
  if (!project.headRevisionId) return project.revisions.at(-1) ?? null;
  return project.revisions.find((r) => r.id === project.headRevisionId) ?? null;
}
