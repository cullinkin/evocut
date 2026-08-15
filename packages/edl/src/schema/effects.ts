import { z } from 'zod';
import { Easing, EffectId, MicrosSchema, Provenance } from './common.js';

/**
 * Effects are the LLM's main expressive surface: it cannot reshoot, so it makes a static
 * talking-head clip watchable with punch-ins, slow pans, and speed ramps on dead air.
 *
 * ## Keyframe timebase
 *
 * Keyframe `t` is measured from the start of the clip **on the output timeline**, i.e.
 * after the clip's `speed` has been applied. A 10s source region at 2x is a 5s clip, and
 * a keyframe at `t = 5_000_000` sits at its very end.
 *
 * This is deliberately the *rendered* timebase rather than the source timebase, because
 * both the scrubber the user sees and the model's own description of the edit ("push in
 * over the last two seconds") are in rendered time. Anchoring to source time would mean
 * every speed change silently slid every zoom.
 */

function keyframe<T extends z.ZodTypeAny>(value: T) {
  return z.object({
    /** Offset from the clip's start on the output timeline. */
    t: MicrosSchema.min(0),
    value,
    /** How to interpolate from this keyframe toward the next one. */
    easing: Easing.default('easeInOut'),
  });
}

/**
 * Framing of the source image inside the output frame.
 *
 * `scale: 1` means the source is fitted to the output frame (cover), so `scale` is a
 * pure zoom factor the model can reason about: 1.15 is a gentle punch-in, 2 is a
 * hard crop. `x`/`y` shift the image, expressed as a fraction of the output frame
 * (`x: 0.25` moves the image a quarter-frame right), so a pan reads the same at any
 * resolution and survives a change of export size.
 */
export const TransformValue = z.object({
  scale: z.number().positive().max(20).default(1),
  x: z.number().min(-4).max(4).default(0),
  y: z.number().min(-4).max(4).default(0),
  rotation: z.number().min(-360).max(360).default(0),
});
export type TransformValue = z.infer<typeof TransformValue>;

/** Normalized crop rectangle in source space; `{0,0,1,1}` is the whole frame. */
export const CropRect = z.object({
  left: z.number().min(0).max(1).default(0),
  top: z.number().min(0).max(1).default(0),
  right: z.number().min(0).max(1).default(1),
  bottom: z.number().min(0).max(1).default(1),
});
export type CropRect = z.infer<typeof CropRect>;

const effectBase = {
  id: EffectId,
  enabled: z.boolean().default(true),
  origin: Provenance.optional(),
};

/** Pan / zoom / rotate, animated. One keyframe means a static framing. */
export const TransformEffect = z.object({
  ...effectBase,
  type: z.literal('transform'),
  keyframes: z.array(keyframe(TransformValue)).min(1),
});
export type TransformEffect = z.infer<typeof TransformEffect>;

/** Static crop applied before framing. */
export const CropEffect = z.object({
  ...effectBase,
  type: z.literal('crop'),
  rect: CropRect,
});
export type CropEffect = z.infer<typeof CropEffect>;

/** Linear gain, animated. `1` is unity; `0` is silence. */
export const VolumeEffect = z.object({
  ...effectBase,
  type: z.literal('volume'),
  keyframes: z.array(keyframe(z.number().min(0).max(8))).min(1),
});
export type VolumeEffect = z.infer<typeof VolumeEffect>;

/** Opacity fade, animated. Used for the head/tail fades and for cross-dissolves. */
export const OpacityEffect = z.object({
  ...effectBase,
  type: z.literal('opacity'),
  keyframes: z.array(keyframe(z.number().min(0).max(1))).min(1),
});
export type OpacityEffect = z.infer<typeof OpacityEffect>;

export const Effect = z.discriminatedUnion('type', [
  TransformEffect,
  CropEffect,
  VolumeEffect,
  OpacityEffect,
]);
export type Effect = z.infer<typeof Effect>;

export type EffectType = Effect['type'];

/** Convenience: a two-keyframe Ken Burns push-in across the clip's full length. */
export function kenBurns(
  id: string,
  durationOut: number,
  from: Partial<TransformValue>,
  to: Partial<TransformValue>,
): TransformEffect {
  const base: TransformValue = { scale: 1, x: 0, y: 0, rotation: 0 };
  return {
    id,
    type: 'transform',
    enabled: true,
    keyframes: [
      { t: 0, value: { ...base, ...from }, easing: 'easeInOut' },
      { t: Math.max(0, durationOut), value: { ...base, ...to }, easing: 'easeInOut' },
    ],
  };
}
