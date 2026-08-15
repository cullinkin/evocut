import {
  clipEnd,
  kenBurns,
  outputDuration,
  type Clip,
  type Op,
  type Project,
  type RefinementPlan,
} from '@evocut/edl';
import { signalsForClip, type ClipSignals, type SourceSignals } from '@evocut/signals';

/**
 * A refinement pass that runs on the device, with no model behind it.
 *
 * **This is a stand-in, not the product.** It exists because the review screen is the piece
 * that turns usage into labelled data, and that screen cannot be built, tested, or
 * dogfooded against a provider we have not wired up yet. Swapping it for a real model is
 * one function: `refineProject` already takes a `complete`, and `localPlanner` satisfies
 * the same shape.
 *
 * ## With signals and without
 *
 * Given measurements of the footage it uses them, and the difference is the whole argument
 * for the signals pass. Blind, it can only say "this clip is long, so push in". With
 * signals it can say "this clip holds still for four seconds and there is a hit at 2.1s,
 * so arrive on the hit" — and the rationale it attaches is something a person can check
 * against what they remember shooting, which is what makes their accept or reject worth
 * recording.
 *
 * The heuristics stay deliberately conservative either way. A pass that proposes forty
 * edits trains people to hit "accept all", and an accept-all is worth nothing as a label.
 */
export interface LocalPlannerOptions {
  /** Trimmed off the head and tail of each clip when nothing better is known. */
  joinTrimUs?: number;
  /** Clips at least this long get a gentle push-in. */
  pushInThresholdUs?: number;
  /** Clips at least this long get sped up. */
  speedUpThresholdUs?: number;
  speedUpRate?: number;
  /** Cap on how many edits one pass may propose. */
  maxOps?: number;
  /** A hit weaker than this is not worth building a moment around. */
  minHitStrength?: number;
  /** What the footage sounds and looks like, by source id. */
  signals?: Map<string, SourceSignals>;
}

const DEFAULTS = {
  joinTrimUs: 250_000,
  pushInThresholdUs: 6_000_000,
  speedUpThresholdUs: 20_000_000,
  speedUpRate: 1.5,
  maxOps: 12,
  minHitStrength: 0.55,
} satisfies Omit<Required<LocalPlannerOptions>, 'signals'>;

export function planLocalRefinement(project: Project, options: LocalPlannerOptions = {}): RefinementPlan {
  const config = { ...DEFAULTS, ...options };
  const ops: Op[] = [];
  const clips = project.timeline.tracks
    .filter((track) => track.kind === 'video' && !track.locked)
    .flatMap((track) => track.clips)
    .filter((clip) => clip.enabled);

  const sources = new Map(project.sources.map((source) => [source.id, source]));
  let usedSignals = false;

  clips.forEach((clip, index) => {
    const source = sources.get(clip.sourceId);
    const duration = outputDuration(clip);
    const measured = options.signals?.get(clip.sourceId);
    const seen = measured ? signalsForClip(clip, measured) : null;
    if (seen && (seen.quiet.length > 0 || seen.hits.length > 0 || seen.still.length > 0)) usedSignals = true;

    // Trim the joins. The head of the first clip and the tail of the last are the
    // recording's own start and end rather than a cut the user made, so they are left
    // alone — the user chose those deliberately.
    const trim = planTrim(clip, index, clips.length, seen, config);
    if (trim && (!source || trim.sourceOut <= source.duration) && trim.sourceOut > trim.sourceIn) {
      if (trim.sourceIn !== clip.sourceIn || trim.sourceOut !== clip.sourceOut) {
        ops.push({
          op: 'trim',
          clipId: clip.id,
          ...(trim.sourceIn !== clip.sourceIn ? { sourceIn: trim.sourceIn } : {}),
          ...(trim.sourceOut !== clip.sourceOut ? { sourceOut: trim.sourceOut } : {}),
          rationale: trim.rationale,
        });
      }
    }

    // Only one framing decision per clip: a speed change and a push-in on the same shot
    // read as two different ideas fighting.
    const framing = planFraming(clip, duration, seen, config);
    if (framing) ops.push(framing);
  });

  return {
    summary: summarize(ops.length, usedSignals),
    ops: ops.slice(0, config.maxOps),
  };
}

type Config = typeof DEFAULTS;

/**
 * Where to trim a join.
 *
 * Blind, it takes a fixed quarter-second off each end and hopes. With signals it trims to
 * the edge of the measured silence instead — which is both more and less than a quarter
 * second, and is the actual thing a person means by "it starts on a breath".
 */
function planTrim(
  clip: Clip,
  index: number,
  total: number,
  seen: ClipSignals | null,
  config: Config,
): { sourceIn: number; sourceOut: number; rationale: string } | null {
  const trimHead = index > 0;
  const trimTail = index < total - 1;
  if (!trimHead && !trimTail) return null;
  if (outputDuration(clip) <= config.joinTrimUs * 4) return null;

  if (seen) {
    // A quiet span touching the head or the tail is dead air at a join, and its far edge
    // is where the clip should actually start or stop.
    const head = seen.quiet.find((region) => region.start <= clip.start + 100_000);
    const tail = seen.quiet.find((region) => region.end >= clipEnd(clip) - 100_000);

    const sourceIn = trimHead && head ? toSource(clip, head.end) : clip.sourceIn;
    const sourceOut = trimTail && tail ? toSource(clip, tail.start) : clip.sourceOut;

    if (sourceIn !== clip.sourceIn || sourceOut !== clip.sourceOut) {
      const where = [
        sourceIn !== clip.sourceIn ? 'opens' : null,
        sourceOut !== clip.sourceOut ? 'ends' : null,
      ].filter(Boolean);
      return {
        sourceIn,
        sourceOut,
        rationale: `${where.join(' and ')} on measured silence`,
      };
    }

    // Signals exist and found no dead air at the join. Guessing anyway would throw away
    // the one thing the measurement was for.
    return null;
  }

  return {
    sourceIn: trimHead ? clip.sourceIn + config.joinTrimUs : clip.sourceIn,
    sourceOut: trimTail ? clip.sourceOut - config.joinTrimUs : clip.sourceOut,
    rationale: 'coarse cuts usually run a beat long at the join',
  };
}

/**
 * Speed, or movement, or nothing.
 *
 * The interesting case is the hit: where something lands inside a shot that is otherwise
 * holding still, the push-in is timed to *arrive* on it rather than running the length of
 * the clip. That is the difference between motion and emphasis.
 */
function planFraming(clip: Clip, duration: number, seen: ClipSignals | null, config: Config): Op | null {
  if (clip.effects.length > 0) return null;
  const effectId = `fx_push_${clip.id.slice(4, 12)}`;

  if (seen) {
    const hit = seen.hits.find((candidate) => candidate.strength >= config.minHitStrength);
    // Leave room to build: a hit in the first half-second has nothing to arrive from.
    if (hit && hit.t - clip.start > 700_000) {
      return {
        op: 'addEffect',
        clipId: clip.id,
        effect: kenBurns(effectId, hit.t - clip.start, { scale: 1 }, { scale: 1.18 }),
        rationale: `something lands at ${seconds(hit.t - clip.start)}s into the shot; the push arrives with it`,
      };
    }

    const stillFor = total(seen.still);
    const quietFor = total(seen.quiet);

    // Nothing happening *and* nothing being said is a passage to get through, and it is
    // checked before the push-in: adding movement to a shot where nobody is talking
    // dresses up dead time instead of shortening it.
    if (quietFor >= duration * 0.5 && stillFor >= duration * 0.5) {
      return {
        op: 'setSpeed',
        clipId: clip.id,
        speed: config.speedUpRate,
        rationale: 'quiet and static for most of its length',
      };
    }

    // Static but not silent: someone is talking to a phone propped on a table.
    if (stillFor >= duration * 0.6 && duration >= config.pushInThresholdUs) {
      return {
        op: 'addEffect',
        clipId: clip.id,
        effect: kenBurns(effectId, duration, { scale: 1 }, { scale: 1.12 }),
        rationale: `the picture barely moves for ${seconds(stillFor)}s of this shot`,
      };
    }

    return null;
  }

  if (duration >= config.speedUpThresholdUs) {
    return {
      op: 'setSpeed',
      clipId: clip.id,
      speed: config.speedUpRate,
      rationale: `${Math.round(duration / 1_000_000)}s on one shot is a long time to hold`,
    };
  }

  if (duration >= config.pushInThresholdUs) {
    return {
      op: 'addEffect',
      clipId: clip.id,
      effect: kenBurns(effectId, duration, { scale: 1 }, { scale: 1.12 }),
      rationale: 'a locked-off shot this long goes dead without some movement',
    };
  }

  return null;
}

function total(regions: Array<{ start: number; end: number }>): number {
  return regions.reduce((sum, region) => sum + (region.end - region.start), 0);
}

function toSource(clip: Clip, outputTime: number): number {
  return clip.sourceIn + Math.round((outputTime - clip.start) * clip.speed);
}

function seconds(us: number): string {
  return (us / 1_000_000).toFixed(1);
}

function summarize(count: number, usedSignals: boolean): string {
  if (count === 0) {
    return usedSignals
      ? 'Nothing worth changing — no dead air at the joins and nothing sitting still.'
      : 'Nothing worth changing — the clips are already short and tight.';
  }
  const noun = count === 1 ? 'edit' : 'edits';
  return usedSignals
    ? `${count} suggested ${noun}, based on where the footage goes quiet, holds still, or lands a hit.`
    : `${count} suggested ${noun}: tightened joins, plus movement on the longer shots.`;
}

/**
 * The local planner in `CompleteFn` shape, so it can be handed to `refineProject`
 * wherever a real model would go.
 */
export function localPlanner(project: Project, options?: LocalPlannerOptions) {
  return async () => planLocalRefinement(project, options) as unknown;
}
