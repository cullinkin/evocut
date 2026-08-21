import type { PictureSignals } from './picture.js';
/**
 * What the footage sounds and looks like.
 *
 * ## Why this package exists
 *
 * The refinement pass was, until now, working blind. It received a text description of the
 * timeline — clip ids, in and out points, durations — and nothing about the footage those
 * points cut into. Asked to "put emphasis on the hits", a model in that position can only
 * guess, and a guess dressed up as a rationale ("adds energy here") is worse than no
 * suggestion at all, because it reads like observation.
 *
 * These are measurements: where the sound spikes, where it goes quiet, where the picture
 * stops moving. They are crude on purpose. A phone has to compute them on the footage it
 * just imported, and a crude number that is actually true beats a sophisticated one that
 * takes forty seconds and drains the battery.
 *
 * ## Timebase
 *
 * Everything in here is in **source** time — the same clock as `Clip.sourceIn`. Signals
 * belong to the recording, not to any particular edit of it, so they survive every trim,
 * split and reorder, and they only have to be computed once per source ever.
 *
 * `summarize.ts` is what converts them into output time, because that is the clock the
 * model has to emit ops in.
 */

/**
 * Bumped when the analysis changes shape, so a cached result is recomputed rather than trusted.
 *
 * 2: audio is measured through the demuxer rather than `decodeAudioData`, so recordings
 * that were too large to load now have loudness where they had nothing; and motion is
 * sampled on its own schedule rather than the filmstrip's, which on a long take is the
 * difference between a sample every twenty seconds and one every three.
 *
 * 5: the picture's movement is read per frame out of the container's sample table rather
 * than from a handful of decoded frames — which is both finer by three orders of magnitude
 * and the removal of six hundred seeks per source, the ones that were freezing the editor.
 *
 * 3: onsets are rate-capped to the sharpest few a minute, so twenty-seven minutes of talking
 * yields hits rather than three and a half thousand syllables; and a slow seek no longer
 * aborts the motion pass, which had been silently returning nothing on real footage. Both
 * of those went wrong on a cached result that looked perfectly valid, which is the case
 * this number exists for.
 */
export const SIGNALS_VERSION = 5;

/** A transient: something struck, said hard, or landed. In source microseconds. */
export interface Onset {
  t: number;
  /** 0..1, relative to the loudest transient in this source. */
  strength: number;
}

/** A span of source time. */
export interface Region {
  start: number;
  end: number;
}

export interface AudioSignals {
  /** Spacing between loudness measurements, in microseconds. */
  hopUs: number;
  /** dBFS per hop, floored at `SILENCE_DB`. */
  loudness: number[];
  /** Loudest hop, in dBFS. Everything else is easier to read against this. */
  peakDb: number;
  /** Median loudness across the whole source — the level "normal" sounds like here. */
  medianDb: number;
  onsets: Onset[];
  /** Stretches quiet enough and long enough to be dead air. */
  quiet: Region[];
}

export interface MotionSignals {
  /** Spacing between motion measurements, in microseconds. */
  hopUs: number;
  /** 0..1 mean absolute change between consecutive sampled frames. */
  motion: number[];
  /** Stretches where almost nothing changes: a locked-off shot, a held frame. */
  still: Region[];
}

export interface SourceSignals {
  version: number;
  sourceId: string;
  /** Fingerprint of the media these were measured from; a mismatch invalidates the cache. */
  contentHash?: string;
  durationUs: number;
  /** Null when the source has no audio, or the browser could not decode it. */
  audio: AudioSignals | null;
  /** Null when no frames were available to compare. */
  motion: MotionSignals | null;
  /**
   * Per-frame movement, read from the container index. Null for anything not an MP4.
   *
   * Kept alongside `motion` rather than replacing it: they answer different questions at
   * different resolutions, and only this one is fine enough to aim a keyframe with.
   */
  picture?: PictureSignals | null;
  computedAt: string;
}

/** Floor for the loudness scale. Below this, "how quiet" stops being a useful distinction. */
export const SILENCE_DB = -100;
