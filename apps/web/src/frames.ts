import type { Rational } from '@evocut/edl';

/**
 * The output's frame grid, which is the only clock in this app that matters to a person.
 *
 * ## Why this is its own file
 *
 * Three things were each rounding to frames in their own coordinate, and the three grids
 * were out of phase with one another:
 *
 * - the **ruler** draws ticks at absolute output frames — `k × frameUs` from the start of
 *   the timeline, which is also where the renderer samples;
 * - the **playhead** was not rounded at all, so parking it left it somewhere inside a
 *   frame rather than on one;
 * - a **keyframe** was rounded against its own clip's start, and clip starts are arbitrary
 *   microseconds — the first coarse cut lands wherever a finger left it.
 *
 * Taken from a real session's EDL: eight keys sitting at exact clip-relative frames landed
 * at absolute frames 93.488, 97.488, 100.488 … — every one of them half a frame off the
 * tick it was aimed at, and half a frame off the instant the renderer would sample it.
 * That is the "I would drop one and it would show up a few frames back or in front".
 *
 * So there is one grid, it is absolute, and everything rounds to it here.
 */

/** One frame, in microseconds. */
export function frameUsOf(frameRate: Rational): number {
  return (1_000_000 * frameRate.den) / Math.max(1, frameRate.num);
}

/**
 * How close two times have to be to count as the same frame.
 *
 * It used to be a flat 66ms — two frames at 30fps — which was a sliver of the screen at the
 * zoom the timeline had when it was written. The timeline now zooms until a third of a
 * second fills the phone, where 66ms is a *fifth of the screen*: you move along a visibly
 * long way, adjust, and the adjustment silently rewrites the keyframe you just made instead
 * of adding one. Reported exactly that way — "if I try moving along the timeline, zooming in
 * to drop another, it just doesn't".
 *
 * A frame is the honest answer, because a frame is the finest distinction the output can
 * carry. Half of one either side, so it means "this frame" and not "this frame or its
 * neighbour".
 */
export function sameFrame(frameUs: number): number {
  return Math.max(1, frameUs / 2);
}

/**
 * The frame boundary a time belongs to, on the timeline's own grid.
 *
 * Keyframes land on frames because frames are what gets rendered. A key at an arbitrary
 * microsecond is a key whose value is never sampled exactly — the frame before it and the
 * frame after it both show an interpolation.
 */
export function snapToFrame(atUs: number, frameUs: number): number {
  if (!Number.isFinite(frameUs) || frameUs <= 0) return Math.round(atUs);
  return Math.round(Math.round(atUs / frameUs) * frameUs);
}

/**
 * Where a keyframe goes for a playhead at `playheadUs`, in the clip's own coordinate.
 *
 * The rounding happens in *absolute* time and the clip's start is subtracted afterwards,
 * which is the whole point: the key then sits on the tick the ruler drew and on the instant
 * the renderer samples, rather than on a grid the clip invented for itself.
 *
 * The result is pulled onto the last frame that is still inside the clip rather than
 * clamped to its edges, because a clamped key is a key at a time no frame is ever rendered
 * at — the same fault one level down.
 */
export function keyframeTimeAt(
  playheadUs: number,
  clipStartUs: number,
  durationUs: number,
  frameUs: number,
): number {
  const loose = () => Math.round(Math.max(0, Math.min(durationUs, playheadUs - clipStartUs)));
  if (!Number.isFinite(frameUs) || frameUs <= 0) return loose();

  const first = Math.ceil(clipStartUs / frameUs);
  const last = Math.floor((clipStartUs + durationUs) / frameUs);
  // A clip shorter than a single frame has no boundary of its own to offer.
  if (last < first) return loose();

  const frame = Math.min(last, Math.max(first, Math.round(playheadUs / frameUs)));
  return Math.round(frame * frameUs - clipStartUs);
}
