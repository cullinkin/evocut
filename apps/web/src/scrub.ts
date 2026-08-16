/**
 * How fast a scrub is allowed to re-aim the video element.
 *
 * ## The bug this is
 *
 * A scroll gesture with momentum emits events for as long as it coasts, and every one of
 * them used to issue a seek. On the twelve-second test clip that is free — a keyframe is
 * always nearby and the decode is a few milliseconds — so every benchmark said the scrub was
 * fine. On a 5 GB 4K recording one keyframe seek is most of a second, and asking for six a
 * second means the element is told to start a new seek before it has finished the last, for
 * the whole gesture. It never completes one, so it never paints one, so the preview goes
 * black and stays black: the freeze reported from a real project. `play()` sometimes cleared
 * it because starting playback resets a state machine that was thrashing.
 *
 * ## The rule
 *
 * One seek in flight, and no faster than the last one took.
 *
 * The first half is the element's own honest signal: `HTMLMediaElement.seeking` is the
 * element saying it is busy. The second half is learned rather than configured, because the
 * right number is four orders of magnitude apart between a phone clip and a 4K master and
 * there is no constant that suits both. Whatever the last completed seek cost eases into the
 * interval, so a small file stays at six a second and a huge one settles to whatever it can
 * actually sustain.
 *
 * ## Why this is a module rather than three refs in the player
 *
 * Because it cannot be tested where it lived. Making a seek slow in a browser test means
 * having media that is slow to seek, and there is no lever that turns a twelve-second webm
 * into a 4K master — CPU throttling starves the test's own rAF loop long before it slows a
 * 360p decode. Here the timings are just numbers, and the rule can be stated exactly.
 */

/**
 * Floor on how often a scrub may re-aim the element.
 *
 * Six a second is faster than anyone can read a frame off a moving preview and slow enough
 * that each one finishes on media where seeks are cheap. It is only the floor: the measured
 * cost takes over the moment media is slower than this.
 */
export const SCRUB_SEEK_INTERVAL_MS = 160;

/**
 * Ceiling on the learned interval.
 *
 * Past this the preview has stopped being a scrubber and become a slideshow, and the
 * filmstrip proxy is carrying the gesture anyway — so there is nothing to buy by backing off
 * further, and a real cost if the element never catches up to where the thumb stopped.
 */
export const MAX_SCRUB_INTERVAL_MS = 900;

/**
 * A seek in flight longer than this is not coming back.
 *
 * `seeking` can stay true indefinitely if the range request behind it stalls, and a gate
 * that trusts it unconditionally would wedge the preview for the rest of the session. Past
 * this the next seek is issued over the top of the stalled one.
 */
export const STALLED_SEEK_MS = 2_000;

/** How strongly a fresh measurement moves the interval. Eased, so one slow seek is not law. */
const BLEND = 0.4;

export interface ScrubPace {
  /** When the seek currently in flight was issued, or 0 when none is. */
  seekStartedAt: number;
  /** When a scrub seek was last issued, in flight or not. */
  lastSeekAt: number;
  /** What a scrub seek is costing on this media right now. */
  intervalMs: number;
}

/** Fresh state, at the optimistic end: assume seeks are cheap until one says otherwise. */
export function newScrubPace(): ScrubPace {
  return { seekStartedAt: 0, lastSeekAt: 0, intervalMs: SCRUB_SEEK_INTERVAL_MS };
}

/**
 * May a scrub seek be issued now?
 *
 * `seeking` is the element's `HTMLMediaElement.seeking`. Both gates have to pass: nothing is
 * in flight (or what is in flight has stalled), *and* enough time has passed since the last
 * one for the pace to be sustainable.
 */
export function shouldSeekNow(pace: ScrubPace, now: number, seeking: boolean): boolean {
  if (seeking && now - pace.seekStartedAt < STALLED_SEEK_MS) return false;
  return now - pace.lastSeekAt >= pace.intervalMs;
}

/** Record that a seek just went out. */
export function noteSeekIssued(pace: ScrubPace, now: number): ScrubPace {
  return { ...pace, lastSeekAt: now, seekStartedAt: now };
}

/**
 * Record that a seek landed, and take its cost as the new pace.
 *
 * A `seeked` with nothing in flight is not ours — playback, a handoff, or the exact seek at
 * the end of a gesture — and must not be measured, or the interval would learn from a number
 * that has nothing to do with scrubbing.
 */
export function noteSeekLanded(pace: ScrubPace, now: number): ScrubPace {
  if (pace.seekStartedAt === 0) return pace;
  return {
    ...pace,
    seekStartedAt: 0,
    intervalMs: nextInterval(pace.intervalMs, now - pace.seekStartedAt),
  };
}

/**
 * The interval after a seek that took `tookMs`.
 *
 * Eased toward the measurement so one slow seek does not set the pace for the rest of the
 * gesture, and clamped at both ends: floored so the arithmetic cannot slow a fast file to a
 * crawl, capped so a stall cannot turn the scrubber off.
 */
export function nextInterval(current: number, tookMs: number): number {
  const blended = current * (1 - BLEND) + Math.max(0, tookMs) * BLEND;
  return Math.min(MAX_SCRUB_INTERVAL_MS, Math.max(SCRUB_SEEK_INTERVAL_MS, blended));
}
