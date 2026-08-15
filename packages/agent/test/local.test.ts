import { describe, expect, it } from 'vitest';
import {
  applyOps,
  createClip,
  createProject,
  createTimeline,
  createTrack,
  makeIdFactory,
  secondsToMicros as S,
  type Project,
  type Source,
} from '@evocut/edl';
import { planLocalRefinement } from '../src/local.js';

function deps(seed = 'l') {
  let tick = 0;
  return {
    newId: makeIdFactory(seed),
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
  };
}

const source: Source = {
  id: 'src_take1',
  locator: { kind: 'opfs', path: 'take1.mp4' },
  name: 'take1.mp4',
  duration: S(300),
};

function projectWith(ranges: Array<[number, number]>): Project {
  const d = deps();
  const clips = ranges.map(([start, end]) =>
    createClip({ sourceId: source.id, sourceIn: S(start), sourceOut: S(end) }, d),
  );
  const timeline = createTimeline({ tracks: [createTrack({ kind: 'video', clips }, d)] }, d);
  return createProject({ sources: [source], timeline }, d);
}

describe('planLocalRefinement', () => {
  it('trims the joins but leaves the recording’s own start and end alone', () => {
    const project = projectWith([
      [0, 10],
      [20, 30],
      [40, 50],
    ]);
    const plan = planLocalRefinement(project, { pushInThresholdUs: Infinity });
    const trims = plan.ops.filter((op) => op.op === 'trim');

    expect(trims).toHaveLength(3);
    // First clip: tail only — its head is where the user started the recording.
    expect(trims[0]).toMatchObject({ sourceOut: S(9.75) });
    expect(trims[0]).not.toHaveProperty('sourceIn');
    // Middle clip: both ends are cuts the user made.
    expect(trims[1]).toMatchObject({ sourceIn: S(20.25), sourceOut: S(29.75) });
    // Last clip: head only.
    expect(trims[2]).toMatchObject({ sourceIn: S(40.25) });
    expect(trims[2]).not.toHaveProperty('sourceOut');
  });

  it('leaves a single clip completely alone', () => {
    const plan = planLocalRefinement(projectWith([[0, 5]]), { pushInThresholdUs: Infinity });
    expect(plan.ops).toEqual([]);
    expect(plan.summary).toMatch(/Nothing worth changing/);
  });

  it('does not trim a clip too short to survive it', () => {
    const project = projectWith([
      [0, 10],
      [20, 20.5],
      [40, 50],
    ]);
    const plan = planLocalRefinement(project, { pushInThresholdUs: Infinity });
    const trimmed = plan.ops.filter((op) => op.op === 'trim').map((op) => op.clipId);
    expect(trimmed).not.toContain(project.timeline.tracks[0]!.clips[1]!.id);
  });

  it('adds a push-in to a long static shot', () => {
    const plan = planLocalRefinement(projectWith([[0, 12]]));
    const effect = plan.ops.find((op) => op.op === 'addEffect');
    expect(effect).toBeDefined();
    if (effect?.op !== 'addEffect' || effect.effect.type !== 'transform') throw new Error('expected a transform');
    expect(effect.effect.keyframes[0]!.value.scale).toBe(1);
    expect(effect.effect.keyframes.at(-1)!.value.scale).toBeCloseTo(1.12, 6);
  });

  it('speeds up a very long shot instead of zooming it', () => {
    const plan = planLocalRefinement(projectWith([[0, 40]]));
    expect(plan.ops.some((op) => op.op === 'setSpeed')).toBe(true);
    expect(plan.ops.some((op) => op.op === 'addEffect')).toBe(false);
  });

  it('does not stack a second push-in on a clip that already has effects', () => {
    const project = projectWith([[0, 12]]);
    const first = planLocalRefinement(project);
    const withEffect = applyOps(project.timeline, first.ops, { sources: project.sources }).timeline;

    const second = planLocalRefinement({ ...project, timeline: withEffect });
    expect(second.ops.some((op) => op.op === 'addEffect')).toBe(false);
  });

  it('ignores clips the coarse pass dropped', () => {
    const project = projectWith([
      [0, 12],
      [20, 32],
    ]);
    const disabled = applyOps(
      project.timeline,
      [{ op: 'setEnabled', clipId: project.timeline.tracks[0]!.clips[0]!.id, enabled: false }],
      { sources: project.sources },
    ).timeline;

    const plan = planLocalRefinement({ ...project, timeline: disabled });
    const touched = new Set(plan.ops.map((op) => ('clipId' in op ? op.clipId : '')));
    expect(touched.has(project.timeline.tracks[0]!.clips[0]!.id)).toBe(false);
  });

  it('caps how much it proposes in one pass', () => {
    // Forty suggestions trains people to hit accept-all, and an accept-all is worth
    // nothing as a label.
    const many = Array.from({ length: 30 }, (_, i) => [i * 10, i * 10 + 8] as [number, number]);
    const plan = planLocalRefinement(projectWith(many), { maxOps: 5 });
    expect(plan.ops).toHaveLength(5);
  });

  it('proposes only ops that actually apply', () => {
    // A rejected op wastes a review slot, so the planner has to check its own work.
    const project = projectWith([
      [0, 10],
      [20, 30],
      [40, 52],
    ]);
    const plan = planLocalRefinement(project);
    const result = applyOps(project.timeline, plan.ops, { sources: project.sources });

    expect(result.errors).toEqual([]);
    expect(result.applied).toHaveLength(plan.ops.length);
  });

  it('gives every op a rationale', () => {
    // The rationale is what the reviewer reads; an op without one is unreviewable.
    const plan = planLocalRefinement(projectWith([
      [0, 12],
      [20, 45],
    ]));
    expect(plan.ops.length).toBeGreaterThan(0);
    for (const op of plan.ops) expect(op.rationale).toBeTruthy();
  });
});
