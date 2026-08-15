/**
 * EvoCut time model.
 *
 * The canonical unit everywhere in an EDL is the **integer microsecond** (`Micros`).
 *
 * Why microseconds:
 *  - WebCodecs (`VideoFrame.timestamp`, `EncodedVideoChunk.timestamp`) is microsecond-based,
 *    and our renderer is built on WebCodecs, so the EDL needs no conversion at render time.
 *  - Integers mean cut points survive JSON round-trips, hashing, and diffing exactly.
 *    Float seconds do not: 1/3s written and re-read is not the same cut.
 *  - One microsecond is ~1/33000 of a frame at 30fps, so it is lossless for any frame rate
 *    we care about, including 24000/1001 and friends.
 *
 * Frame rates are rationals (`{num, den}`) for the same reason: 29.97 is not a number,
 * it is 30000/1001, and rounding it drifts a full frame every ~30 minutes.
 */

/** Integer count of microseconds. Always >= 0 when used as a duration or media offset. */
export type Micros = number;

/** An exact frame rate, e.g. NTSC 30fps is `{ num: 30000, den: 1001 }`. */
export interface Rational {
  num: number;
  den: number;
}

export const MICROS_PER_SECOND = 1_000_000;
export const MICROS_PER_MINUTE = 60 * MICROS_PER_SECOND;
export const MICROS_PER_HOUR = 60 * MICROS_PER_MINUTE;

export const FPS_24: Rational = { num: 24, den: 1 };
export const FPS_25: Rational = { num: 25, den: 1 };
export const FPS_30: Rational = { num: 30, den: 1 };
export const FPS_50: Rational = { num: 50, den: 1 };
export const FPS_60: Rational = { num: 60, den: 1 };
/** 23.976 */
export const FPS_23_976: Rational = { num: 24000, den: 1001 };
/** 29.97 */
export const FPS_29_97: Rational = { num: 30000, den: 1001 };
/** 59.94 */
export const FPS_59_94: Rational = { num: 60000, den: 1001 };

export function secondsToMicros(seconds: number): Micros {
  return Math.round(seconds * MICROS_PER_SECOND);
}

export function microsToSeconds(us: Micros): number {
  return us / MICROS_PER_SECOND;
}

export function millisToMicros(ms: number): Micros {
  return Math.round(ms * 1000);
}

export function microsToMillis(us: Micros): number {
  return us / 1000;
}

export function rationalToNumber(r: Rational): number {
  return r.num / r.den;
}

/** Duration of a single frame at the given rate, in microseconds (unrounded division). */
export function frameDurationMicros(rate: Rational): number {
  return (MICROS_PER_SECOND * rate.den) / rate.num;
}

/**
 * Index of the frame containing `us`: the largest N with `frameToMicros(N) <= us`.
 *
 * The correction step is not paranoia. Frame starts are stored as integer microseconds,
 * so frame 1 at 30fps is 33333us while its exact rational position is 33333.33us. A plain
 * `floor` of the exact division therefore reports frame 0 for a time that *is* frame 1's
 * own start, and `microsToFrame(frameToMicros(n))` stops being the identity — which would
 * put every frame-snapped cut one frame early.
 */
export function microsToFrame(us: Micros, rate: Rational): number {
  let frame = Math.floor((us * rate.num) / (rate.den * MICROS_PER_SECOND));
  if (frameToMicros(frame + 1, rate) <= us) frame += 1;
  else if (frameToMicros(frame, rate) > us) frame -= 1;
  return frame;
}

/** Presentation time of the start of frame `frame`. */
export function frameToMicros(frame: number, rate: Rational): Micros {
  return Math.round((frame * rate.den * MICROS_PER_SECOND) / rate.num);
}

/**
 * Snap a time to a frame boundary.
 *
 * Coarse cuts made by a human dragging on a phone screen land wherever they land; the
 * renderer wants boundaries. We snap at render/normalize time rather than at capture time
 * so the log keeps the human's real gesture for the training set.
 */
export function snapToFrame(
  us: Micros,
  rate: Rational,
  mode: 'floor' | 'ceil' | 'nearest' = 'nearest',
): Micros {
  const exact = (us * rate.num) / (rate.den * MICROS_PER_SECOND);
  const frame =
    mode === 'floor' ? Math.floor(exact) : mode === 'ceil' ? Math.ceil(exact) : Math.round(exact);
  return frameToMicros(frame, rate);
}

/** True when `us` sits exactly on a frame boundary (within a microsecond of rounding). */
export function isFrameAligned(us: Micros, rate: Rational): boolean {
  return snapToFrame(us, rate, 'nearest') === us;
}

export interface TimecodeOptions {
  /** Include the frame field, e.g. `00:01:23:12`. Requires `rate`. */
  frames?: boolean;
  /** Drop the hours field when zero, e.g. `1:23.500`. */
  compact?: boolean;
}

/**
 * Human-readable timecode. Used in the UI and, importantly, in LLM prompts —
 * the model reasons about `00:01:23.500` far more reliably than about `83500000`.
 */
export function formatTimecode(us: Micros, rate?: Rational, opts: TimecodeOptions = {}): string {
  const negative = us < 0;
  const abs = Math.abs(Math.round(us));

  const hours = Math.floor(abs / MICROS_PER_HOUR);
  const minutes = Math.floor((abs % MICROS_PER_HOUR) / MICROS_PER_MINUTE);
  const seconds = Math.floor((abs % MICROS_PER_MINUTE) / MICROS_PER_SECOND);
  const rest = abs % MICROS_PER_SECOND;

  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const head =
    opts.compact && hours === 0 ? `${minutes}:${pad(seconds)}` : `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;

  let tail: string;
  if (opts.frames) {
    if (!rate) throw new Error('formatTimecode: `frames` requires a frame rate');
    // Frame within the current second, not the absolute frame index.
    const frame = Math.floor((rest * rate.num) / (rate.den * MICROS_PER_SECOND));
    tail = `:${pad(frame)}`;
  } else {
    tail = `.${pad(Math.floor(rest / 1000), 3)}`;
  }

  return `${negative ? '-' : ''}${head}${tail}`;
}

const TIMECODE_RE = /^(-)?(?:(\d+):)?(?:(\d+):)?(\d+)(?:[.,](\d{1,6})|:(\d+))?$/;

/**
 * Parse `HH:MM:SS.mmm`, `MM:SS.mmm`, `SS`, or frame-based `HH:MM:SS:FF` (needs `rate`).
 * Returns `null` rather than throwing, because this parses user and model input.
 */
export function parseTimecode(input: string, rate?: Rational): Micros | null {
  const match = TIMECODE_RE.exec(input.trim());
  if (!match) return null;

  const [, sign, a, b, c, fraction, frameField] = match;

  // The regex fills the numeric groups left to right, so `MM:SS` lands in (a, c).
  let hours = 0;
  let minutes = 0;
  const seconds = Number(c);
  if (a !== undefined && b !== undefined) {
    hours = Number(a);
    minutes = Number(b);
  } else if (a !== undefined) {
    minutes = Number(a);
  }

  let us = hours * MICROS_PER_HOUR + minutes * MICROS_PER_MINUTE + seconds * MICROS_PER_SECOND;

  if (fraction !== undefined) {
    us += Number(fraction.padEnd(6, '0'));
  } else if (frameField !== undefined) {
    if (!rate) return null;
    us += Math.round((Number(frameField) * rate.den * MICROS_PER_SECOND) / rate.num);
  }

  return sign ? -us : us;
}

/** A half-open range `[start, end)` in microseconds. */
export interface Range {
  start: Micros;
  end: Micros;
}

export function rangeDuration(r: Range): Micros {
  return Math.max(0, r.end - r.start);
}

export function rangesOverlap(a: Range, b: Range): boolean {
  return a.start < b.end && b.start < a.end;
}

export function intersectRanges(a: Range, b: Range): Range | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return start < end ? { start, end } : null;
}

export function clampMicros(us: Micros, min: Micros, max: Micros): Micros {
  return Math.min(Math.max(us, min), max);
}
