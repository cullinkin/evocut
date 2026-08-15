import { z } from 'zod';
import { ClipId, EffectId, NonNegativeMicrosSchema, SourceId, TrackId } from './common.js';
import { ColorValue, Effect } from './effects.js';
import { ClipAudio } from './clip.js';

/**
 * The edit language.
 *
 * The LLM never writes a timeline. It emits `Op`s against clip ids and the engine applies
 * them, for three reasons:
 *
 *  1. **It cannot drift.** A model asked to return a whole EDL will quietly renumber a
 *     `start`, drop a clip, or invent a source id. Ops touch one thing each and are
 *     validated against the timeline they are applied to.
 *  2. **Every change is reviewable.** An op list is a diff. The user can see "trimmed
 *     0.4s of silence off the head of clip 3" and reject that one op.
 *  3. **It is the training signal.** `(coarse timeline, ops, accepted?)` is exactly the
 *     triple we want to learn from, and it is only available if the refinement pass is
 *     expressed as discrete decisions rather than a rewritten document.
 *
 * Times in ops are on the **output timeline** unless the field name says `source`.
 * That matches what the model was shown.
 */

const withRationale = {
  /**
   * Why this edit. Required from the LLM (the agent package enforces it), optional in the
   * schema so human-originated ops do not have to invent one. Kept verbatim for training.
   */
  rationale: z.string().max(1000).optional(),
};

/** Change a clip's used region. Omitted edges are left alone. */
export const TrimOp = z.object({
  op: z.literal('trim'),
  clipId: ClipId,
  sourceIn: NonNegativeMicrosSchema.optional(),
  sourceOut: NonNegativeMicrosSchema.optional(),
  ...withRationale,
});

/**
 * Cut a clip in two at `at`, an absolute time on the output timeline.
 * The left half keeps the original id; the right half gets `newClipId` (generated if absent).
 */
export const SplitOp = z.object({
  op: z.literal('split'),
  clipId: ClipId,
  at: NonNegativeMicrosSchema,
  newClipId: ClipId.optional(),
  ...withRationale,
});

/** Delete a clip outright. Everything after it ripples left. */
export const RemoveOp = z.object({
  op: z.literal('remove'),
  clipId: ClipId,
  ...withRationale,
});

/**
 * Drop a clip from the render without deleting it. Preferred over `remove` for
 * model-proposed cuts, so the user can flip it back on.
 */
export const SetEnabledOp = z.object({
  op: z.literal('setEnabled'),
  clipId: ClipId,
  enabled: z.boolean(),
  ...withRationale,
});

/** Reorder a clip within its track. `toIndex` is the target index after removal. */
export const MoveOp = z.object({
  op: z.literal('move'),
  clipId: ClipId,
  toIndex: z.number().int().min(0),
  ...withRationale,
});

/** Change playback rate. Reflows everything downstream. */
export const SetSpeedOp = z.object({
  op: z.literal('setSpeed'),
  clipId: ClipId,
  speed: z.number().positive().min(0.05).max(20),
  ...withRationale,
});

/** Attach an effect (pan/zoom, crop, volume, opacity) to a clip. */
export const AddEffectOp = z.object({
  op: z.literal('addEffect'),
  clipId: ClipId,
  effect: Effect,
  ...withRationale,
});

/**
 * Set (or clear) a clip's colour grade.
 *
 * Not `addEffect`, because a grade is one per clip and a slider emits a new value every
 * time it moves. An add would stack a hundred effects on the way to one look; this
 * replaces, so the op is idempotent and the EDL says what the clip looks like rather than
 * how the person arrived at it. `null` clears the grade entirely — which is what Reset is.
 */
export const SetColorOp = z.object({
  op: z.literal('setColor'),
  clipId: ClipId,
  color: ColorValue.nullable(),
  ...withRationale,
});

export const RemoveEffectOp = z.object({
  op: z.literal('removeEffect'),
  clipId: ClipId,
  effectId: EffectId,
  ...withRationale,
});

export const SetAudioOp = z.object({
  op: z.literal('setAudio'),
  clipId: ClipId,
  audio: ClipAudio.partial(),
  ...withRationale,
});

export const SetLabelOp = z.object({
  op: z.literal('setLabel'),
  clipId: ClipId,
  label: z.string().max(200),
  ...withRationale,
});

/** Add a new region of a source to a track. Used to restore footage the coarse pass cut. */
export const InsertClipOp = z.object({
  op: z.literal('insertClip'),
  trackId: TrackId,
  sourceId: SourceId,
  sourceIn: NonNegativeMicrosSchema,
  sourceOut: NonNegativeMicrosSchema,
  /** Insertion index within the track. Appends when omitted. */
  atIndex: z.number().int().min(0).optional(),
  clipId: ClipId.optional(),
  speed: z.number().positive().min(0.05).max(20).optional(),
  ...withRationale,
});

export const Op = z.discriminatedUnion('op', [
  TrimOp,
  SplitOp,
  RemoveOp,
  SetEnabledOp,
  MoveOp,
  SetSpeedOp,
  AddEffectOp,
  SetColorOp,
  RemoveEffectOp,
  SetAudioOp,
  SetLabelOp,
  InsertClipOp,
]);
export type Op = z.infer<typeof Op>;
export type OpKind = Op['op'];

export type TrimOp = z.infer<typeof TrimOp>;
export type SplitOp = z.infer<typeof SplitOp>;
export type RemoveOp = z.infer<typeof RemoveOp>;
export type SetEnabledOp = z.infer<typeof SetEnabledOp>;
export type MoveOp = z.infer<typeof MoveOp>;
export type SetSpeedOp = z.infer<typeof SetSpeedOp>;
export type AddEffectOp = z.infer<typeof AddEffectOp>;
export type SetColorOp = z.infer<typeof SetColorOp>;
export type RemoveEffectOp = z.infer<typeof RemoveEffectOp>;
export type SetAudioOp = z.infer<typeof SetAudioOp>;
export type SetLabelOp = z.infer<typeof SetLabelOp>;
export type InsertClipOp = z.infer<typeof InsertClipOp>;

/** What one refinement pass returns: a batch of ops plus the model's own summary. */
export const RefinementPlan = z.object({
  /** One-paragraph description of the pass, for the review screen. */
  summary: z.string().max(4000).optional(),
  ops: z.array(Op),
});
export type RefinementPlan = z.infer<typeof RefinementPlan>;

/** Times in an op, for range-checking against a source or the timeline. */
export function opTargetClipIds(op: Op): string[] {
  return 'clipId' in op && op.clipId ? [op.clipId] : [];
}
