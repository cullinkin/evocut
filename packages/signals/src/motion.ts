import { findRuns, median } from './audio.js';
import type { MotionSignals } from './types.js';

/**
 * How much the picture is moving.
 *
 * Mean absolute difference between consecutive sampled frames, on luma only. That is the
 * crudest possible measure and it answers the one question the refinement pass actually
 * asks of the picture: *is this shot alive or is it a person standing still talking to a
 * phone on a table?* A locked-off shot is where a push-in earns its place; a shot that is
 * already moving is where one looks like a mistake.
 *
 * It does not distinguish camera movement from subject movement, and a hard exposure
 * change reads as motion. Both are acceptable — the answer is used to decide whether to
 * suggest a slow zoom, not to steer anything.
 *
 * ## Where the frames come from
 *
 * The app's filmstrip extractor seeks through every source anyway, so motion rides along
 * with that pass. It does **not** ride on the thumbnail spacing, though, and the
 * difference matters: thumbnails are budgeted for what fits under a thumb, which on a
 * 27-minute recording is one every twenty seconds. Two frames twenty seconds apart are
 * unrelated pictures, and differencing them measures nothing. The extractor therefore
 * samples luma on its own, finer schedule, and what arrives here is spaced by the length
 * of the recording rather than by the width of the screen.
 *
 * The spacing is still coarse in absolute terms — a few seconds on a long take — which is
 * the right resolution for "is this shot locked off" and the wrong one for anything about
 * a single gesture. Nothing downstream asks it for the latter.
 */

/** A frame reduced to luma, small. 32×32 is enough to tell movement from stillness. */
export interface LumaFrame {
  /** Position in the source, in microseconds. */
  t: number;
  width: number;
  height: number;
  /** One byte per pixel, row major. */
  luma: Uint8Array;
}

export interface MotionAnalysisOptions {
  /** Below this fraction of the source's own typical movement, a shot counts as still. */
  stillBelow?: number;
  /** Shorter stretches than this are a pause, not a static shot. */
  minStillMs?: number;
}

const DEFAULTS = { stillBelow: 0.4, minStillMs: 1500 } satisfies Required<MotionAnalysisOptions>;

export function analyzeMotion(frames: LumaFrame[], options: MotionAnalysisOptions = {}): MotionSignals | null {
  const settings = { ...DEFAULTS, ...options };
  if (frames.length < 2) return null;

  const hopUs = Math.max(1, Math.round((frames.at(-1)!.t - frames[0]!.t) / (frames.length - 1)));
  const motion: number[] = [0];

  for (let index = 1; index < frames.length; index += 1) {
    motion.push(frameDifference(frames[index - 1]!, frames[index]!));
  }
  // The first frame has nothing to be compared against. Leaving it at zero would report
  // every source as opening on a static shot, so it borrows its successor's value.
  motion[0] = motion[1] ?? 0;

  // Relative to the source's own typical movement, for the same reason loudness is: a
  // handheld take and a tripod take have different floors and both have still passages.
  const typical = Math.max(0.004, median(motion.slice(1)));
  const still = findRuns(motion, hopUs, (value) => value < typical * settings.stillBelow, settings.minStillMs);

  // Each measurement describes the interval *ending* at its frame, so a run of still
  // measurements spans from the frame before the run to the last frame in it. Without the
  // shift a held shot appears to start one sample after it actually did.
  const start = frames[0]!.t;
  return {
    hopUs,
    motion: motion.map((value) => Number(value.toFixed(4))),
    still: still.map((region) => ({
      start: Math.max(start, start + region.start - hopUs),
      end: Math.max(start, start + region.end - hopUs),
    })),
  };
}

/** Mean absolute luma difference, 0..1. Returns 0 for frames that cannot be compared. */
export function frameDifference(a: LumaFrame, b: LumaFrame): number {
  if (a.width !== b.width || a.height !== b.height) return 0;
  if (a.luma.length !== b.luma.length || a.luma.length === 0) return 0;

  let total = 0;
  for (let i = 0; i < a.luma.length; i += 1) total += Math.abs(a.luma[i]! - b.luma[i]!);
  return total / (a.luma.length * 255);
}

/** Rec. 601 luma from RGBA pixels, which is what a canvas hands back. */
export function lumaFromRgba(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i += 1) {
    const at = i * 4;
    out[i] = (rgba[at]! * 77 + rgba[at + 1]! * 150 + rgba[at + 2]! * 29) >> 8;
  }
  return out;
}
