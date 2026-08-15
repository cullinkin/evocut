import { z } from 'zod';
import { ClipId, NonNegativeMicrosSchema, Provenance, SourceId } from './common.js';
import type { Micros } from '../time.js';
import { Effect } from './effects.js';

/**
 * One contiguous region of a source, placed on the timeline.
 *
 * A clip holds **both** its source range and its timeline position. The position is
 * redundant — it is derivable by walking the track — but storing it means the renderer
 * and the LLM never have to do that walk, and a corrupted position is a validation error
 * rather than a silent misrender. `normalizeTimeline()` recomputes it after every edit.
 */
export const ClipAudio = z.object({
  /** Linear gain applied to the whole clip, before any volume keyframes. */
  gain: z.number().min(0).max(8).default(1),
  mute: z.boolean().default(false),
});
export type ClipAudio = z.infer<typeof ClipAudio>;

export const Clip = z.object({
  id: ClipId,
  sourceId: SourceId,

  /** Start of the used region within the source. Inclusive. */
  sourceIn: NonNegativeMicrosSchema,
  /** End of the used region within the source. Exclusive; must be > `sourceIn`. */
  sourceOut: NonNegativeMicrosSchema,

  /**
   * Start of the clip on the output timeline. Maintained by `normalizeTimeline()`;
   * treat it as derived state, not something to hand-edit.
   */
  start: NonNegativeMicrosSchema,

  /**
   * Playback rate. 2 is double speed, 0.5 is half.
   *
   * Output duration is `(sourceOut - sourceIn) / speed`, which is why speed lives on the
   * clip rather than in `effects`: it changes the clip's footprint on the timeline, and
   * everything downstream has to reflow when it changes.
   */
  speed: z.number().positive().min(0.05).max(20).default(1),

  /**
   * Disabled clips keep their place in the list and their source range but contribute
   * nothing to the render. The LLM uses this instead of `remove` when it wants a cut to
   * be reviewable — and the pair (was kept, then dropped) is worth more as training data
   * than a clip that simply vanished.
   */
  enabled: z.boolean().default(true),

  audio: ClipAudio.default({ gain: 1, mute: false }),
  effects: z.array(Effect).default([]),

  /** Short human or model label, e.g. "intro", "dead air before the demo". */
  label: z.string().max(200).optional(),
  origin: Provenance.optional(),
});
export type Clip = z.infer<typeof Clip>;

/** Length of the clip's source region, before speed. */
export function sourceDuration(clip: Pick<Clip, 'sourceIn' | 'sourceOut'>): Micros {
  return Math.max(0, clip.sourceOut - clip.sourceIn);
}

/** Length of the clip on the output timeline, after speed. */
export function outputDuration(clip: Pick<Clip, 'sourceIn' | 'sourceOut' | 'speed'>): Micros {
  return Math.round(sourceDuration(clip) / clip.speed);
}

/** End of the clip on the output timeline. */
export function clipEnd(clip: Clip): Micros {
  return clip.start + outputDuration(clip);
}

/**
 * Map a time on the output timeline to the corresponding time in the source.
 * Returns `null` when `at` falls outside the clip.
 */
export function timelineToSource(clip: Clip, at: Micros): Micros | null {
  if (at < clip.start || at >= clipEnd(clip)) return null;
  return clip.sourceIn + Math.round((at - clip.start) * clip.speed);
}

/**
 * Map a time in the source to the output timeline.
 * Returns `null` when the source time is outside the clip's used region.
 */
export function sourceToTimeline(clip: Clip, sourceAt: Micros): Micros | null {
  if (sourceAt < clip.sourceIn || sourceAt >= clip.sourceOut) return null;
  return clip.start + Math.round((sourceAt - clip.sourceIn) / clip.speed);
}

/**
 * How far each edge of a clip can be dragged.
 *
 * A trim handle can move in two directions and they mean different things: inwards
 * shortens the clip, outwards recovers footage the coarse pass cut away. The outward
 * limit is the source itself, so this is where "drag the end to extend" gets its stop.
 *
 * `headroom` is what the UI draws as the ghost either side of a selected clip — without
 * it, nothing on screen says that extending is even possible.
 */
export interface TrimBounds {
  /** Range `sourceIn` may take. */
  inMin: Micros;
  inMax: Micros;
  /** Range `sourceOut` may take. */
  outMin: Micros;
  outMax: Micros;
  /** Unused source before and after the clip, in source time. */
  headroom: { head: Micros; tail: Micros };
}

export function trimBounds(
  clip: Pick<Clip, 'sourceIn' | 'sourceOut'>,
  sourceDurationUs: Micros,
  minDurationUs = 100_000,
): TrimBounds {
  // Never let a drag collapse a clip to nothing; `normalizeTimeline` would drop it and
  // the user would watch their clip vanish mid-gesture.
  const floor = Math.min(minDurationUs, Math.max(1, sourceDurationUs));
  return {
    inMin: 0,
    inMax: Math.max(0, clip.sourceOut - floor),
    outMin: Math.min(clip.sourceIn + floor, sourceDurationUs),
    outMax: sourceDurationUs,
    headroom: {
      head: clip.sourceIn,
      tail: Math.max(0, sourceDurationUs - clip.sourceOut),
    },
  };
}
