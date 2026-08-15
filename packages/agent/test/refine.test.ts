import { describe, expect, it, vi } from 'vitest';
import {
  createClip,
  createTimeline,
  createTrack,
  createProject,
  freezeCoarsePass,
  makeIdFactory,
  secondsToMicros as S,
  type Project,
  type Source,
} from '@evocut/edl';
import { buildRefinementPrompt, parseRefinementResponse, refineProject, summarizeOps } from '../src/index.js';

function deps(seed = 'a') {
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
  duration: S(60),
};

function coarseProject(): Project {
  const d = deps();
  const clips = [
    createClip({ sourceId: 'src_take1', sourceIn: S(2), sourceOut: S(10), label: 'intro' }, d),
    createClip({ sourceId: 'src_take1', sourceIn: S(18), sourceOut: S(30), label: 'demo' }, d),
  ];
  const timeline = createTimeline({ tracks: [createTrack({ kind: 'video', clips }, d)] }, d);
  return freezeCoarsePass(createProject({ sources: [source], timeline }, d), d);
}

const CLIP_A = 'clp_a1';
const CLIP_B = 'clp_a2';

describe('buildRefinementPrompt', () => {
  it('gives the model clip ids and the coarse cut points', () => {
    const prompt = buildRefinementPrompt(coarseProject());
    expect(prompt).toContain(CLIP_A);
    expect(prompt).toContain('coarse cut: dropped 00:00:08.000 of source here');
    expect(prompt).toContain('propose_edits');
  });

  it('passes the user instruction through', () => {
    const prompt = buildRefinementPrompt(coarseProject(), { instruction: 'keep it punchy' });
    expect(prompt).toContain('keep it punchy');
  });

  it('shows rejected ops verbatim on a repair round', () => {
    const prompt = buildRefinementPrompt(coarseProject(), {
      previousErrors: [{ op: { op: 'remove', clipId: 'clp_ghost' }, message: 'no clip clp_ghost' }],
    });
    expect(prompt).toContain('clp_ghost');
    expect(prompt).toContain('rejected: no clip clp_ghost');
    expect(prompt).toContain('do not repeat the edits that succeeded');
  });
});

describe('parseRefinementResponse', () => {
  it('accepts a well-formed plan', () => {
    const plan = parseRefinementResponse({
      summary: 'tightened the head',
      ops: [{ op: 'trim', clipId: CLIP_A, sourceIn: S(2.4), rationale: 'starts on an inhale' }],
    });
    expect(plan.ops).toHaveLength(1);
  });

  it('accepts a bare op array', () => {
    expect(parseRefinementResponse([{ op: 'remove', clipId: CLIP_A }]).ops).toHaveLength(1);
  });

  it('rejects an invented op kind rather than silently dropping it', () => {
    expect(() => parseRefinementResponse({ ops: [{ op: 'addMusic', clipId: CLIP_A }] })).toThrow(
      /did not match the op schema/,
    );
  });
});

describe('refineProject', () => {
  it('applies a clean pass in one round', async () => {
    const complete = vi.fn().mockResolvedValue({
      summary: 'Tightened both heads.',
      ops: [
        { op: 'trim', clipId: CLIP_A, sourceIn: S(2.4), rationale: 'starts on an inhale' },
        { op: 'setSpeed', clipId: CLIP_B, speed: 1.5, rationale: 'the walk-over is slow' },
      ],
    });

    const result = await refineProject(coarseProject(), { complete, model: 'test-model' });

    expect(result.rounds).toBe(1);
    expect(result.rejected).toEqual([]);
    expect(result.summary).toBe('Tightened both heads.');
    expect(result.project.timeline.tracks[0]!.clips[0]!.sourceIn).toBe(S(2.4));
    expect(result.project.revisions.at(-1)!.model).toBe('test-model');
    // The human's pass is still recoverable after the model has touched the timeline.
    expect(result.project.coarseSnapshot!.tracks[0]!.clips[0]!.sourceIn).toBe(S(2));
  });

  it('repairs a rejected op without re-sending the ones that landed', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce({
        ops: [
          { op: 'setLabel', clipId: CLIP_A, label: 'opening', rationale: 'names the section' },
          { op: 'trim', clipId: 'clp_ghost', sourceIn: S(1), rationale: 'stale id' },
        ],
      })
      .mockResolvedValueOnce({
        ops: [{ op: 'trim', clipId: CLIP_B, sourceIn: S(18.5), rationale: 'retargeted' }],
      });

    const result = await refineProject(coarseProject(), { complete });

    expect(result.rounds).toBe(2);
    expect(result.rejected).toEqual([]);
    expect(result.revisions).toHaveLength(2);
    expect(result.project.timeline.tracks[0]!.clips[0]!.label).toBe('opening');
    expect(result.project.timeline.tracks[0]!.clips[1]!.sourceIn).toBe(S(18.5));

    const repairPrompt = complete.mock.calls[1]![0].prompt;
    expect(repairPrompt).toContain('clp_ghost');
  });

  it('gives up after the repair budget and hands the failures back', async () => {
    const complete = vi.fn().mockResolvedValue({
      ops: [{ op: 'remove', clipId: 'clp_ghost', rationale: 'still wrong' }],
    });

    const result = await refineProject(coarseProject(), { complete, maxRepairRounds: 1 });

    expect(result.rounds).toBe(2);
    expect(result.rejected).toHaveLength(1);
    // The caller decides what to do with these; the package does not retry forever.
    expect(result.rejected[0]!.message).toMatch(/no clip clp_ghost/);
  });

  it('stops early when the model proposes nothing', async () => {
    const complete = vi.fn().mockResolvedValue({ summary: 'Already tight.', ops: [] });
    const result = await refineProject(coarseProject(), { complete });

    expect(result.rounds).toBe(1);
    expect(result.revisions).toEqual([]);
    expect(result.summary).toBe('Already tight.');
  });
});

describe('summarizeOps', () => {
  it('counts by kind for the review screen', () => {
    expect(
      summarizeOps([
        { op: 'trim', clipId: CLIP_A },
        { op: 'trim', clipId: CLIP_B },
        { op: 'setSpeed', clipId: CLIP_B, speed: 2 },
      ]),
    ).toEqual({ trim: 2, setSpeed: 1 });
  });
});
