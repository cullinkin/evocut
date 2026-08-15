import { z } from 'zod';
import { Actor, NonNegativeMicrosSchema, ProjectId, RevisionId, Timestamp } from './common.js';
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
/**
 * One human verdict on one proposed op.
 *
 * The rejections matter as much as the acceptances, and they are the half that is easy to
 * lose: an op the user waved away leaves no trace on the timeline. Recording the verdict
 * against the op that earned it is what turns a refinement pass into labelled data rather
 * than just a diff that happened.
 */
export const OpVerdict = z.object({
  op: Op,
  accepted: z.boolean(),
  /** Optional reason, when the user gave one. Free text; never shown to the model. */
  note: z.string().max(500).optional(),
});
export type OpVerdict = z.infer<typeof OpVerdict>;

export const RevisionReview = z.object({
  /** Every op the pass proposed, in the order it proposed them, each with its verdict. */
  verdicts: z.array(OpVerdict),
  reviewedAt: Timestamp,
});
export type RevisionReview = z.infer<typeof RevisionReview>;

export const Revision = z.object({
  id: RevisionId,
  parentId: RevisionId.optional(),
  at: Timestamp,
  by: Actor,
  /**
   * Ops that take the parent revision's timeline to this one.
   *
   * After a review this is the *accepted subset*, not everything proposed — a revision
   * records what happened. The full proposal lives in `review.verdicts`.
   */
  ops: z.array(Op),
  /** Model's summary of the pass, or a human note. */
  summary: z.string().max(4000).optional(),
  /** Model identifier, when `by === 'llm'`. */
  model: z.string().max(200).optional(),
  /**
   * Per-op verdicts, when a human reviewed this pass. Absent means not yet reviewed.
   */
  review: RevisionReview.optional(),
  /**
   * Pass-level outcome: did the human keep anything from it? Absent means not yet
   * reviewed. Coarser than `review` and derived from it, but worth storing separately
   * so a training export can filter passes without walking every verdict.
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

/**
 * A refinement pass the user is still deciding on.
 *
 * Held on the project rather than in component state, and for a specific reason: the
 * verdicts are the product. A phone will background a tab mid-review, and a review that
 * lived in memory would lose exactly the judgements this whole tool exists to collect.
 *
 * ## The one rule
 *
 * `baseline` is the timeline **without** any of these suggestions. The project's live
 * `timeline` is always `baseline` plus the accepted ones, re-derived. That single rule is
 * what makes a suggestion reversible: un-accepting is not an undo of some past mutation,
 * it is the same derivation with one fewer op. Nothing has to be inverted, and the result
 * cannot drift from what the user thinks they accepted.
 *
 * A manual edit made while a review is open goes to the `baseline`, so it composes with
 * the suggestions instead of racing them. If it invalidates one — deleting the clip a
 * suggestion targets — that suggestion stops applying and says so, rather than silently
 * doing something else.
 */
export const ReviewSession = z.object({
  id: z.string().max(200),
  /** Whether a model or the local heuristics produced this pass. */
  by: z.enum(['model', 'heuristics']),
  model: z.string().max(200).optional(),
  summary: z.string().max(4000).optional(),
  ops: z.array(Op),
  /** Parallel to `ops`. Nothing starts accepted; that is the point of the screen. */
  accepted: z.array(z.boolean()),
  /** The timeline as it stands without any of these suggestions. */
  baseline: Timeline,
  createdAt: Timestamp,
});
export type ReviewSession = z.infer<typeof ReviewSession>;

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

  /**
   * What this particular edit is meant to be, in the user's own words.
   *
   * Per project, not per device. A booster bundle and a twenty-minute build log want
   * opposite things from the same model, and a global setting would make every project
   * after the first one wrong by default. The API key stays global — it belongs to the
   * phone; this belongs to the video.
   */
  brief: z.string().max(4000).optional(),
  /**
   * How long the finished thing should run, in microseconds.
   *
   * A first-class number rather than a sentence in the brief, because it is the one
   * instruction the model can check its own work against: it can see every clip's length
   * and add them up. Stated in prose it is a wish; stated as a number it is arithmetic.
   */
  targetDurationUs: NonNegativeMicrosSchema.optional(),

  /** A refinement pass awaiting judgement. See `ReviewSession`. */
  review: ReviewSession.optional(),

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
