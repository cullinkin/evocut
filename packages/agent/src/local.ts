import {
  kenBurns,
  outputDuration,
  type Op,
  type Project,
  type RefinementPlan,
} from '@evocut/edl';

/**
 * A refinement pass that runs on the device, with no model behind it.
 *
 * **This is a stand-in, not the product.** It applies fixed heuristics — trim a fraction
 * off each join, punch in on long static clips, speed up the very long ones — where the
 * real pass will listen to the audio and watch the footage.
 *
 * It exists because the review screen is the piece that turns usage into labelled data,
 * and that screen cannot be built, tested, or dogfooded against a provider we have not
 * wired up yet. Swapping it for a real model is one function: `refineProject` already
 * takes a `complete`, and `localPlanner` satisfies the same shape.
 *
 * The heuristics are deliberately conservative. A pass that proposes forty edits trains
 * people to hit "accept all", and an accept-all is worth nothing as a label.
 */
export interface LocalPlannerOptions {
  /** Trimmed off the head and tail of each clip. Coarse cuts nearly always run long. */
  joinTrimUs?: number;
  /** Clips at least this long get a gentle push-in. */
  pushInThresholdUs?: number;
  /** Clips at least this long get sped up. */
  speedUpThresholdUs?: number;
  speedUpRate?: number;
  /** Cap on how many edits one pass may propose. */
  maxOps?: number;
}

const DEFAULTS: Required<LocalPlannerOptions> = {
  joinTrimUs: 250_000,
  pushInThresholdUs: 6_000_000,
  speedUpThresholdUs: 20_000_000,
  speedUpRate: 1.5,
  maxOps: 12,
};

export function planLocalRefinement(project: Project, options: LocalPlannerOptions = {}): RefinementPlan {
  const config = { ...DEFAULTS, ...options };
  const ops: Op[] = [];
  const clips = project.timeline.tracks
    .filter((track) => track.kind === 'video' && !track.locked)
    .flatMap((track) => track.clips)
    .filter((clip) => clip.enabled);

  const sources = new Map(project.sources.map((source) => [source.id, source]));

  clips.forEach((clip, index) => {
    const source = sources.get(clip.sourceId);
    const duration = outputDuration(clip);

    // Trim the joins. The head of the first clip and the tail of the last are the
    // recording's own start and end rather than a cut the user made, so they are left
    // alone — the user chose those deliberately.
    const trimHead = index > 0;
    const trimTail = index < clips.length - 1;
    if ((trimHead || trimTail) && duration > config.joinTrimUs * 4) {
      const sourceIn = trimHead ? clip.sourceIn + config.joinTrimUs : clip.sourceIn;
      const sourceOut = trimTail ? clip.sourceOut - config.joinTrimUs : clip.sourceOut;
      // Never propose an edit that would not apply; a rejected op wastes a review slot.
      if (sourceOut > sourceIn && (!source || sourceOut <= source.duration)) {
        ops.push({
          op: 'trim',
          clipId: clip.id,
          ...(trimHead ? { sourceIn } : {}),
          ...(trimTail ? { sourceOut } : {}),
          rationale: 'coarse cuts usually run a beat long at the join',
        });
      }
    }

    if (duration >= config.speedUpThresholdUs) {
      ops.push({
        op: 'setSpeed',
        clipId: clip.id,
        speed: config.speedUpRate,
        rationale: `${Math.round(duration / 1_000_000)}s on one shot is a long time to hold`,
      });
    } else if (duration >= config.pushInThresholdUs && clip.effects.length === 0) {
      ops.push({
        op: 'addEffect',
        clipId: clip.id,
        effect: kenBurns(`fx_push_${clip.id.slice(4, 12)}`, duration, { scale: 1 }, { scale: 1.12 }),
        rationale: 'a locked-off shot this long goes dead without some movement',
      });
    }
  });

  return {
    summary:
      ops.length === 0
        ? 'Nothing worth changing — the clips are already short and tight.'
        : `${ops.length} suggested ${ops.length === 1 ? 'edit' : 'edits'}: tightened joins, plus movement on the longer shots.`,
    ops: ops.slice(0, config.maxOps),
  };
}

/**
 * The local planner in `CompleteFn` shape, so it can be handed to `refineProject`
 * wherever a real model would go.
 */
export function localPlanner(project: Project, options?: LocalPlannerOptions) {
  return async () => planLocalRefinement(project, options) as unknown;
}
