import { applyOps, type ApplyContext } from './apply.js';
import { describeOp } from './describe.js';
import { outputDuration, type Clip } from './schema/clip.js';
import { findClip, timelineDuration, type Timeline } from './schema/timeline.js';
import type { Op } from './schema/ops.js';
import type { ReviewSession } from './schema/project.js';
import { formatTimecode } from './time.js';

/**
 * A live refinement review: what the timeline looks like, and what each suggestion does.
 *
 * ## Derivation, not mutation
 *
 * `resolveReview` is the whole mechanism. The visible timeline is *always* recomputed as
 * `baseline + the accepted ops`, so accepting is adding one to that list and un-accepting
 * is removing it. There is no undo stack, no inverse op, and no way for the timeline to
 * disagree with the ticks on screen — which is what makes "put it back" trustworthy
 * enough to be worth offering.
 *
 * The cost is that this runs on every toggle. It is `applyOps` over a handful of ops on a
 * timeline of a few dozen clips; on a phone that is well under a frame.
 *
 * ## Previews are per-op, deliberately
 *
 * Each preview is computed by applying **that op alone** to the baseline, not by taking
 * the difference between two cumulative states. A user deciding on one suggestion is
 * asking "what does this one do?", and the honest answer to that is the op in isolation.
 * Where two suggestions touch the same clip the sum will differ slightly from the parts —
 * which is a real property of the edit, not an artefact, and the whole-timeline duration
 * shown alongside is always the true derived one.
 */

/** What one suggestion does, in the terms a review screen needs to draw it. */
export interface OpPreview {
  index: number;
  op: Op;
  clipId: string | null;
  /**
   * Where this lands on the timeline the user is looking at, in output microseconds.
   *
   * Taken from the *visible* timeline where the clip still exists, so a bubble stays over
   * its clip as earlier accepted suggestions shorten everything before it.
   */
  anchorUs: number;
  /** The affected clip before and after, for a side-by-side. Null where there is no one clip. */
  before: Clip | null;
  after: Clip | null;
  /** Output length of that clip, before and after. */
  beforeLengthUs: number;
  afterLengthUs: number;
  /** What this op alone does to the whole timeline's length. Negative means shorter. */
  deltaUs: number;
  /** One line, in plain words: what it does and what it costs. */
  headline: string;
  /** False when the op no longer applies — usually a manual edit removed its clip. */
  applicable: boolean;
  reason: string | null;
}

export interface ResolvedReview {
  /** `baseline` plus every accepted op, in the order the pass proposed them. */
  timeline: Timeline;
  /** Parallel to `session.ops`: was it accepted *and* did it apply? */
  landed: boolean[];
  /** Accepted ops the engine refused, with why. Shown rather than silently dropped. */
  failures: Array<{ index: number; message: string }>;
}

/**
 * The timeline as it stands: the user's own edit, plus the suggestions they kept.
 *
 * Accepted ops are applied in the order the model proposed them regardless of the order
 * they were ticked, because that is the order they were reasoned about — a trim and a
 * speed change on the same clip do not commute.
 */
export function resolveReview(session: ReviewSession, ctx: ApplyContext = {}): ResolvedReview {
  const chosen: Array<{ index: number; op: Op }> = [];
  session.ops.forEach((op, index) => {
    if (session.accepted[index]) chosen.push({ index, op });
  });

  const result = applyOps(
    session.baseline,
    chosen.map((entry) => entry.op),
    ctx,
  );

  const landed = session.ops.map(() => false);
  const failed = new Set(result.errors.map((error) => chosen[error.index]!.index));
  for (const entry of chosen) if (!failed.has(entry.index)) landed[entry.index] = true;

  return {
    timeline: result.timeline,
    landed,
    failures: result.errors.map((error) => ({
      index: chosen[error.index]!.index,
      message: error.message,
    })),
  };
}

export function previewOps(
  session: ReviewSession,
  visible: Timeline,
  ctx: ApplyContext = {},
): OpPreview[] {
  return session.ops.map((op, index) => previewOp(session.baseline, op, visible, index, ctx));
}

export function previewOp(
  baseline: Timeline,
  op: Op,
  visible: Timeline,
  index: number,
  ctx: ApplyContext = {},
): OpPreview {
  const clipId = 'clipId' in op && op.clipId ? op.clipId : null;
  const before = clipId ? findClip(baseline, clipId)?.clip ?? null : null;

  const result = applyOps(baseline, [op], ctx);
  const failure = result.errors[0] ?? null;
  const after = clipId && !failure ? findClip(result.timeline, clipId)?.clip ?? null : null;

  const beforeLengthUs = before ? outputDuration(before) : 0;
  const afterLengthUs = after ? outputDuration(after) : 0;

  return {
    index,
    op,
    clipId,
    anchorUs: anchorFor(op, clipId, visible, baseline),
    before,
    after,
    beforeLengthUs,
    afterLengthUs,
    deltaUs: failure ? 0 : timelineDuration(result.timeline) - timelineDuration(baseline),
    headline: headlineFor(op, baseline, before, after),
    applicable: !failure,
    reason: failure ? failure.message : null,
  };
}

/**
 * Where to pin the bubble.
 *
 * The visible timeline first, because that is what is on screen and its clips have already
 * been moved by whatever else was accepted. The baseline is the fallback for a suggestion
 * whose clip the *suggestion itself* removed — that bubble still has to sit somewhere, and
 * where the clip used to start is the only honest answer.
 */
function anchorFor(op: Op, clipId: string | null, visible: Timeline, baseline: Timeline): number {
  if (op.op === 'split') return op.at;
  if (!clipId) return 0;
  const live = findClip(visible, clipId)?.clip;
  if (live) return live.start + outputDuration(live) / 2;
  const original = findClip(baseline, clipId)?.clip;
  return original ? original.start + outputDuration(original) / 2 : 0;
}

/**
 * One line saying what happens and what it costs.
 *
 * `describeOp` says what the op *is*; this says what it *does to your video*, because that
 * is the question being answered on a review screen. "Trim clip 7" and "cuts 4.2 seconds
 * of silence off the front of clip 7" are the same op and only one of them is a decision
 * anyone can make from a phone.
 */
function headlineFor(op: Op, baseline: Timeline, before: Clip | null, after: Clip | null): string {
  const seconds = (us: number) => `${(Math.abs(us) / 1_000_000).toFixed(2)}s`;

  if (op.op === 'trim' && before && after) {
    const head = after.sourceIn - before.sourceIn;
    const tail = before.sourceOut - after.sourceOut;
    const parts: string[] = [];
    if (head > 0) parts.push(`${seconds(head)} off the head`);
    else if (head < 0) parts.push(`${seconds(head)} back onto the head`);
    if (tail > 0) parts.push(`${seconds(tail)} off the tail`);
    else if (tail < 0) parts.push(`${seconds(tail)} back onto the tail`);
    if (parts.length > 0) return `Trim ${parts.join(' and ')}`;
    return 'Trim (no change)';
  }

  if (op.op === 'setSpeed' && before) {
    const now = outputDuration(before);
    const then = Math.round((before.sourceOut - before.sourceIn) / op.speed);
    return `Play at ${op.speed}× — ${seconds(now)} becomes ${seconds(then)}`;
  }

  if ((op.op === 'remove' || (op.op === 'setEnabled' && !op.enabled)) && before) {
    return `Drop this shot — ${seconds(outputDuration(before))} out`;
  }

  if (op.op === 'setEnabled' && op.enabled && before) {
    return `Bring this shot back — ${seconds(outputDuration(before))} in`;
  }

  if (op.op === 'addEffect') {
    const effect = op.effect;
    if (effect.type === 'transform') {
      // A push-in and a pull-back are the same effect with the keyframes the other way
      // round, and calling both of them "transform" tells the person nothing about what
      // they are agreeing to.
      const first = effect.keyframes[0]?.value.scale ?? 1;
      const last = effect.keyframes.at(-1)?.value.scale ?? first;
      const over = effect.keyframes.at(-1)?.t ?? 0;
      const span = over > 0 ? ` over ${seconds(over)}` : '';
      if (last > first + 0.01) return `Push in to ${last.toFixed(2)}×${span}`;
      if (last < first - 0.01) return `Pull back to ${last.toFixed(2)}×${span}`;
      return `Hold the framing at ${last.toFixed(2)}×`;
    }
    if (effect.type === 'volume') return 'Ride the level on this shot';
    if (effect.type === 'opacity') return 'Fade this shot';
    if (effect.type === 'crop') return 'Crop this shot';
  }

  if (op.op === 'split') {
    return `Cut here, at ${formatTimecode(op.at, undefined, { compact: true })}`;
  }

  if (op.op === 'setAudio') {
    if (op.audio.mute) return 'Mute this shot';
    if (typeof op.audio.gain === 'number') return `Set the level to ${Math.round(op.audio.gain * 100)}%`;
  }

  return describeOp(op, baseline);
}

/**
 * How the whole edit stands against its target.
 *
 * Shown next to the review because the individual suggestions are unreadable without it:
 * "trims 0.45s" means nothing on its own and everything when the number underneath says
 * you are two minutes over.
 */
export interface LengthStanding {
  currentUs: number;
  targetUs: number | null;
  /** Positive means over target. Null when no target is set. */
  overUs: number | null;
  label: string;
}

export function lengthStanding(timeline: Timeline, targetUs: number | undefined): LengthStanding {
  const currentUs = timelineDuration(timeline);
  const current = runtime(currentUs);
  if (!targetUs) return { currentUs, targetUs: null, overUs: null, label: current };

  const overUs = currentUs - targetUs;
  const target = runtime(targetUs);
  const gap = runtime(Math.abs(overUs));
  return {
    currentUs,
    targetUs,
    overUs,
    label:
      Math.abs(overUs) < 1_000_000
        ? `${current} — on target`
        : `${current} of ${target} — ${gap} ${overUs > 0 ? 'over' : 'under'}`,
  };
}

/**
 * A running time, to the second.
 *
 * Not `formatTimecode`: that resolves to the millisecond because it labels cut points,
 * where a frame matters. A running length is a different quantity — nobody cuts a video to
 * three minutes and forty seconds *and 250 milliseconds* — and the extra digits make two
 * numbers harder to compare at a glance, which is the only thing this label is for.
 */
function runtime(us: number): string {
  const total = Math.round(us / 1_000_000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
