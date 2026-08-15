import { describe, expect, it } from 'vitest';
import { commitOps } from '../src/factory.js';
import { describeOp } from '../src/describe.js';
import { Project, type OpVerdict } from '../src/schema/project.js';
import { kenBurns } from '../src/schema/effects.js';
import type { Op } from '../src/schema/ops.js';
import { COARSE_CLIP_IDS, makeCoarseProject, makeCoarseTimeline, S, testDeps } from './fixtures.js';

const [FIRST, SECOND] = COARSE_CLIP_IDS;
const timeline = makeCoarseTimeline();

describe('describeOp', () => {
  it('describes a trim by how much it moves each edge', () => {
    // Clip 1 runs 2s–10s in the source.
    expect(describeOp({ op: 'trim', clipId: FIRST, sourceIn: S(2.4) }, timeline)).toBe(
      'Trim 0:00.400 off the head of clip 1 (intro)',
    );
    expect(describeOp({ op: 'trim', clipId: FIRST, sourceOut: S(9.5) }, timeline)).toBe(
      'Trim 0:00.500 off the tail of clip 1 (intro)',
    );
    expect(describeOp({ op: 'trim', clipId: FIRST, sourceIn: S(1.5) }, timeline)).toBe(
      'Extend 0:00.500 onto the head of clip 1 (intro)',
    );
    expect(describeOp({ op: 'trim', clipId: FIRST, sourceIn: S(2.4), sourceOut: S(9.5) }, timeline)).toBe(
      'Trim 0:00.400 off the head and trim 0:00.500 off the tail of clip 1 (intro)',
    );
  });

  it('names clips by position and label, not by id', () => {
    // The reviewer is looking at their own video, not at a data structure.
    expect(describeOp({ op: 'remove', clipId: SECOND }, timeline)).toBe('Delete clip 2 (demo)');
    expect(describeOp({ op: 'setEnabled', clipId: SECOND, enabled: false }, timeline)).toBe(
      'Drop clip 2 (demo)',
    );
  });

  it('describes the rest of the op kinds', () => {
    const cases: Array<[Op, string]> = [
      [{ op: 'split', clipId: FIRST, at: S(3.5) }, 'Split clip 1 (intro) at 0:03.500'],
      [{ op: 'setSpeed', clipId: FIRST, speed: 1.5 }, 'Speed up clip 1 (intro) to 1.5×'],
      [{ op: 'setSpeed', clipId: FIRST, speed: 0.5 }, 'Slow down clip 1 (intro) to 0.5×'],
      [{ op: 'move', clipId: FIRST, toIndex: 2 }, 'Move clip 1 (intro) to position 3'],
      [{ op: 'setAudio', clipId: FIRST, audio: { mute: true } }, 'Mute clip 1 (intro)'],
      [{ op: 'setAudio', clipId: FIRST, audio: { gain: 0.5 } }, 'Set clip 1 (intro) volume to 50%'],
      [{ op: 'setLabel', clipId: FIRST, label: 'opening' }, 'Label clip 1 (intro) "opening"'],
      [
        { op: 'addEffect', clipId: FIRST, effect: kenBurns('fx_a', S(8), { scale: 1 }, { scale: 1.2 }) },
        'Push in from 1× to 1.2× on clip 1 (intro)',
      ],
      [
        {
          op: 'insertClip',
          trackId: timeline.tracks[0]!.id,
          sourceId: 'src_take1',
          sourceIn: S(10),
          sourceOut: S(14),
        },
        'Restore 0:04.000 of footage from src_take1',
      ],
    ];

    for (const [op, expected] of cases) {
      expect(describeOp(op, timeline)).toBe(expected);
    }
  });

  it('falls back to the raw id for a clip that does not exist yet', () => {
    // A later op in a batch can target something an earlier op created.
    expect(describeOp({ op: 'remove', clipId: 'clp_future' }, timeline)).toBe('Delete clp_future');
    expect(describeOp({ op: 'remove', clipId: 'clp_future' })).toBe('Delete clp_future');
  });
});

describe('reviewed revisions', () => {
  const proposal: Op[] = [
    { op: 'trim', clipId: FIRST, sourceIn: S(2.4), rationale: 'starts on an inhale' },
    { op: 'setSpeed', clipId: SECOND, speed: 1.5, rationale: 'the walk-over drags' },
    { op: 'remove', clipId: SECOND, rationale: 'redundant with the intro' },
  ];

  it('applies only the accepted ops but records every verdict', () => {
    const verdicts: OpVerdict[] = [
      { op: proposal[0]!, accepted: true },
      { op: proposal[1]!, accepted: true },
      { op: proposal[2]!, accepted: false, note: 'no, I want that section' },
    ];

    const result = commitOps(
      makeCoarseProject(),
      verdicts.filter((v) => v.accepted).map((v) => v.op),
      { by: 'llm', model: 'test-model', review: { verdicts }, ...testDeps('r') },
    );

    expect(result.revision.ops).toHaveLength(2);
    // The rejected op leaves no mark on the timeline, so the review is the only
    // place it survives — and rejections are the half of the label that is easy to lose.
    expect(result.revision.review!.verdicts).toHaveLength(3);
    expect(result.revision.review!.verdicts[2]!.accepted).toBe(false);
    expect(result.revision.review!.verdicts[2]!.note).toBe('no, I want that section');
    expect(result.project.timeline.tracks[0]!.clips).toHaveLength(3);
  });

  it('marks a pass rejected when the user waved everything away', () => {
    const verdicts: OpVerdict[] = proposal.map((op) => ({ op, accepted: false }));
    const result = commitOps(makeCoarseProject(), [], {
      by: 'llm',
      review: { verdicts },
      ...testDeps('r'),
    });

    expect(result.revision.accepted).toBe(false);
    expect(result.revision.ops).toEqual([]);
  });

  it('marks a pass accepted when anything at all survived', () => {
    const verdicts: OpVerdict[] = [
      { op: proposal[0]!, accepted: true },
      { op: proposal[1]!, accepted: false },
    ];
    const result = commitOps(makeCoarseProject(), [proposal[0]!], {
      by: 'llm',
      review: { verdicts },
      ...testDeps('r'),
    });

    expect(result.revision.accepted).toBe(true);
  });

  it('leaves accepted absent on an unreviewed pass', () => {
    const result = commitOps(makeCoarseProject(), [proposal[0]!], { by: 'llm', ...testDeps('r') });
    expect(result.revision.accepted).toBeUndefined();
    expect(result.revision.review).toBeUndefined();
  });

  it('survives a JSON round-trip with the verdicts intact', () => {
    const verdicts: OpVerdict[] = [
      { op: proposal[0]!, accepted: true },
      { op: proposal[2]!, accepted: false, note: 'keep that bit' },
    ];
    const { project } = commitOps(makeCoarseProject(), [proposal[0]!], {
      by: 'llm',
      review: { verdicts },
      ...testDeps('r'),
    });

    const reparsed = Project.parse(JSON.parse(JSON.stringify(project)));
    expect(reparsed.revisions.at(-1)!.review!.verdicts).toEqual(verdicts);
  });
});
