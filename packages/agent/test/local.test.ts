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
import { SIGNALS_VERSION, type SourceSignals } from '@evocut/signals';
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

/**
 * The same planner, given measurements of the footage.
 *
 * This is the argument for the signals pass in one place: blind, the planner can only
 * reason about how long a clip is. With signals it reasons about what is *in* it — and
 * more importantly, it stops proposing things the footage does not support.
 */
function measured(over: Partial<SourceSignals> = {}): Map<string, SourceSignals> {
  return new Map([
    [
      source.id,
      {
        version: SIGNALS_VERSION,
        sourceId: source.id,
        durationUs: source.duration,
        computedAt: '2026-01-01T00:00:00.000Z',
        audio: { hopUs: 50_000, loudness: [], peakDb: -6, medianDb: -22, onsets: [], quiet: [] },
        motion: { hopUs: S(1), motion: [], still: [] },
        ...over,
      } satisfies SourceSignals,
    ],
  ]);
}

describe('planLocalRefinement with signals', () => {
  it('trims to the edge of the measured silence rather than a fixed guess', () => {
    const project = projectWith([
      [0, 10],
      [20, 30],
    ]);
    // 1.4 seconds of dead air at the head of the second clip, which starts at source 20s.
    const signals = measured({
      audio: {
        hopUs: 50_000,
        loudness: [],
        peakDb: -6,
        medianDb: -22,
        onsets: [],
        quiet: [{ start: S(20), end: S(21.4) }],
      },
    });

    const plan = planLocalRefinement(project, { signals, pushInThresholdUs: Infinity });
    const trim = plan.ops.find(
      (op) => op.op === 'trim' && op.clipId === project.timeline.tracks[0]!.clips[1]!.id,
    );
    // 21.4s, not the blind 20.25s — the measurement is the point.
    expect(trim).toMatchObject({ sourceIn: S(21.4) });
    expect(trim?.rationale).toMatch(/silence/);
  });

  it('stops guessing at a join once it can tell there is nothing to trim', () => {
    // Blind, this pass trims a quarter-second off both joins on principle. Measured, it
    // knows the clips start on sound and leaves them alone.
    const project = projectWith([
      [0, 10],
      [20, 30],
    ]);
    const plan = planLocalRefinement(project, { signals: measured(), pushInThresholdUs: Infinity });
    expect(plan.ops.filter((op) => op.op === 'trim')).toEqual([]);
  });

  it('times a push-in to arrive on a hit', () => {
    const project = projectWith([[0, 12]]);
    const signals = measured({
      audio: {
        hopUs: 50_000,
        loudness: [],
        peakDb: -3,
        medianDb: -22,
        onsets: [{ t: S(4), strength: 0.9 }],
        quiet: [],
      },
    });

    const plan = planLocalRefinement(project, { signals });
    const effect = plan.ops.find((op) => op.op === 'addEffect');
    if (effect?.op !== 'addEffect' || effect.effect.type !== 'transform') throw new Error('expected a transform');

    // The zoom ends where the hit lands, not where the clip does.
    expect(effect.effect.keyframes.at(-1)!.t).toBe(S(4));
    expect(effect.rationale).toMatch(/lands at 4\.0s/);
  });

  it('ignores a hit too weak to build a moment around', () => {
    const project = projectWith([[0, 12]]);
    const signals = measured({
      audio: {
        hopUs: 50_000,
        loudness: [],
        peakDb: -3,
        medianDb: -22,
        onsets: [{ t: S(4), strength: 0.2 }],
        quiet: [],
      },
      motion: { hopUs: S(1), motion: [], still: [] },
    });

    const plan = planLocalRefinement(project, { signals });
    expect(plan.ops).toEqual([]);
  });

  it('pushes in on a shot measured as static, not merely long', () => {
    const project = projectWith([[0, 12]]);
    const still = measured({ motion: { hopUs: S(1), motion: [], still: [{ start: 0, end: S(10) }] } });

    expect(planLocalRefinement(project, { signals: still }).ops.some((op) => op.op === 'addEffect')).toBe(true);
    // The same twelve seconds, measured as moving: blind it would still get a push-in.
    expect(planLocalRefinement(project, { signals: measured() }).ops).toEqual([]);
  });

  it('speeds up a passage that is both quiet and still', () => {
    const project = projectWith([[0, 12]]);
    const signals = measured({
      audio: {
        hopUs: 50_000,
        loudness: [],
        peakDb: -40,
        medianDb: -22,
        onsets: [],
        quiet: [{ start: S(2), end: S(11) }],
      },
      motion: { hopUs: S(1), motion: [], still: [{ start: S(1), end: S(11) }] },
    });

    const plan = planLocalRefinement(project, { signals });
    // Static and silent for most of its length is the definition of a bit to get through.
    expect(plan.ops.some((op) => op.op === 'setSpeed')).toBe(true);
  });

  it('says in the summary that it looked at the footage', () => {
    const project = projectWith([[0, 12]]);
    const still = measured({ motion: { hopUs: S(1), motion: [], still: [{ start: 0, end: S(10) }] } });
    expect(planLocalRefinement(project, { signals: still }).summary).toMatch(/quiet|still|hit/);
  });

  it('still proposes only ops that apply', () => {
    const project = projectWith([
      [0, 10],
      [20, 30],
      [40, 52],
    ]);
    const signals = measured({
      audio: {
        hopUs: 50_000,
        loudness: [],
        peakDb: -6,
        medianDb: -22,
        onsets: [{ t: S(44), strength: 0.8 }],
        quiet: [{ start: S(20), end: S(21.4) }, { start: S(28.5), end: S(30) }],
      },
      motion: { hopUs: S(1), motion: [], still: [{ start: S(40), end: S(48) }] },
    });

    const plan = planLocalRefinement(project, { signals });
    const result = applyOps(project.timeline, plan.ops, { sources: project.sources });
    expect(result.errors).toEqual([]);
    expect(result.applied).toHaveLength(plan.ops.length);
  });
});
