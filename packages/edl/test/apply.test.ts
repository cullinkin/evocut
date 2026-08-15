import { describe, expect, it } from 'vitest';
import { applyOps } from '../src/apply.js';
import { clipEnd, outputDuration } from '../src/schema/clip.js';
import { findClip, timelineDuration } from '../src/schema/timeline.js';
import { kenBurns } from '../src/schema/effects.js';
import type { Op } from '../src/schema/ops.js';
import { makeIdFactory } from '../src/schema/common.js';
import { COARSE_CLIP_IDS, makeCoarseTimeline, makeSource, S } from './fixtures.js';

const sources = [makeSource()];
const ctx = () => ({ sources, newId: makeIdFactory('n') });
const [FIRST, SECOND, THIRD] = COARSE_CLIP_IDS;

describe('applyOps', () => {
  it('leaves the input timeline untouched', () => {
    const timeline = makeCoarseTimeline();
    const snapshot = structuredClone(timeline);
    applyOps(timeline, [{ op: 'remove', clipId: FIRST }], ctx());
    expect(timeline).toEqual(snapshot);
  });

  it('ripples later clips left when one is removed', () => {
    const timeline = makeCoarseTimeline();
    expect(timelineDuration(timeline)).toBe(S(8 + 12 + 8));

    const result = applyOps(timeline, [{ op: 'remove', clipId: FIRST }], ctx());

    expect(result.errors).toEqual([]);
    const clips = result.timeline.tracks[0]!.clips;
    expect(clips.map((c) => c.id)).toEqual([SECOND, THIRD]);
    expect(clips[0]!.start).toBe(0);
    expect(clips[1]!.start).toBe(S(12));
    expect(timelineDuration(result.timeline)).toBe(S(20));
  });

  it('reclaims output time when a clip is disabled', () => {
    const result = applyOps(
      makeCoarseTimeline(),
      [{ op: 'setEnabled', clipId: SECOND, enabled: false }],
      ctx(),
    );

    const clips = result.timeline.tracks[0]!.clips;
    expect(clips).toHaveLength(3);
    // The clip stays on the timeline for review, but contributes no duration —
    // otherwise toggling it off would leave a hole of black.
    expect(clips[2]!.start).toBe(S(8));
    expect(timelineDuration(result.timeline)).toBe(S(16));
  });
});

describe('trim', () => {
  it('adjusts one edge and reflows', () => {
    const result = applyOps(
      makeCoarseTimeline(),
      [{ op: 'trim', clipId: FIRST, sourceIn: S(4) }],
      ctx(),
    );

    const clips = result.timeline.tracks[0]!.clips;
    expect(clips[0]!.sourceIn).toBe(S(4));
    expect(clips[0]!.sourceOut).toBe(S(10));
    expect(clips[1]!.start).toBe(S(6));
  });

  it('rejects a trim past the end of the source', () => {
    const result = applyOps(
      makeCoarseTimeline(),
      [{ op: 'trim', clipId: THIRD, sourceOut: S(90) }],
      ctx(),
    );

    expect(result.applied).toEqual([]);
    expect(result.errors[0]!.message).toMatch(/runs past the end of source/);
  });

  it('rejects an inverted range', () => {
    const result = applyOps(
      makeCoarseTimeline(),
      [{ op: 'trim', clipId: FIRST, sourceIn: S(10), sourceOut: S(2) }],
      ctx(),
    );
    expect(result.errors[0]!.message).toMatch(/must be greater than sourceIn/);
  });
});

describe('split', () => {
  it('cuts at a timeline time and maps it back into the source', () => {
    const result = applyOps(makeCoarseTimeline(), [{ op: 'split', clipId: FIRST, at: S(3) }], ctx());

    expect(result.errors).toEqual([]);
    const clips = result.timeline.tracks[0]!.clips;
    expect(clips).toHaveLength(4);
    expect(clips[0]!.sourceIn).toBe(S(2));
    expect(clips[0]!.sourceOut).toBe(S(5));
    expect(clips[1]!.sourceIn).toBe(S(5));
    expect(clips[1]!.sourceOut).toBe(S(10));
    expect(clips[1]!.start).toBe(S(3));
    expect(clips[2]!.start).toBe(S(8));
  });

  it('accounts for speed when mapping the cut point', () => {
    const result = applyOps(
      makeCoarseTimeline(),
      [
        { op: 'setSpeed', clipId: FIRST, speed: 2 },
        // The clip is now 4s of output; cutting at 1s of output is 2s into its source.
        { op: 'split', clipId: FIRST, at: S(1) },
      ],
      ctx(),
    );

    expect(result.errors).toEqual([]);
    const clips = result.timeline.tracks[0]!.clips;
    expect(clips[0]!.sourceOut).toBe(S(4));
    expect(clips[1]!.sourceIn).toBe(S(4));
    expect(outputDuration(clips[0]!)).toBe(S(1));
  });

  it('bakes the interpolated effect value into both halves', () => {
    const timeline = makeCoarseTimeline();
    const result = applyOps(
      timeline,
      [
        { op: 'addEffect', clipId: FIRST, effect: kenBurns('fx_zoom', S(8), { scale: 1 }, { scale: 2 }) },
        { op: 'split', clipId: FIRST, at: S(4) },
      ],
      ctx(),
    );

    expect(result.errors).toEqual([]);
    const clips = result.timeline.tracks[0]!.clips;
    const left = clips[0]!.effects[0]!;
    const right = clips[1]!.effects[0]!;

    if (left.type !== 'transform' || right.type !== 'transform') throw new Error('expected transforms');
    // Half way through an easeInOut push from 1 to 2 is exactly 1.5, and both sides
    // must agree on it or the cut would visibly jump.
    expect(left.keyframes.at(-1)!.value.scale).toBeCloseTo(1.5, 6);
    expect(right.keyframes[0]!.value.scale).toBeCloseTo(1.5, 6);
    expect(right.keyframes[0]!.t).toBe(0);
    expect(right.keyframes.at(-1)!.t).toBe(S(4));
    expect(right.id).not.toBe(left.id);
  });

  it('refuses to split on a clip edge', () => {
    const result = applyOps(makeCoarseTimeline(), [{ op: 'split', clipId: FIRST, at: 0 }], ctx());
    expect(result.applied).toEqual([]);
    expect(result.errors[0]!.message).toMatch(/not strictly inside/);
  });
});

describe('partial failure', () => {
  it('applies the good ops and reports the bad one with its batch index', () => {
    // The realistic failure: a model emits a stale id partway through a long batch.
    // Nineteen good edits must not be lost because of one bad reference.
    const ops: Op[] = [
      { op: 'setLabel', clipId: FIRST, label: 'opening' },
      { op: 'remove', clipId: 'clp_ghost' },
      { op: 'setSpeed', clipId: SECOND, speed: 1.5 },
    ];

    const result = applyOps(makeCoarseTimeline(), ops, ctx());

    expect(result.applied).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.index).toBe(1);
    expect(result.errors[0]!.message).toMatch(/no clip clp_ghost/);
    expect(findClip(result.timeline, FIRST)!.clip.label).toBe('opening');
    expect(findClip(result.timeline, SECOND)!.clip.speed).toBe(1.5);
  });

  it('lets a later op address a clip an earlier op created', () => {
    const result = applyOps(
      makeCoarseTimeline(),
      [
        { op: 'split', clipId: FIRST, at: S(4), newClipId: 'clp_tail' },
        { op: 'setSpeed', clipId: 'clp_tail', speed: 2 },
      ],
      ctx(),
    );

    expect(result.errors).toEqual([]);
    expect(findClip(result.timeline, 'clp_tail')!.clip.speed).toBe(2);
  });
});

describe('move, speed, audio, effects', () => {
  it('reorders within the track and reflows', () => {
    const result = applyOps(makeCoarseTimeline(), [{ op: 'move', clipId: THIRD, toIndex: 0 }], ctx());
    const clips = result.timeline.tracks[0]!.clips;
    expect(clips.map((c) => c.id)).toEqual([THIRD, FIRST, SECOND]);
    expect(clips[0]!.start).toBe(0);
    expect(clips[1]!.start).toBe(S(8));
  });

  it('clamps an out-of-range move index', () => {
    const result = applyOps(makeCoarseTimeline(), [{ op: 'move', clipId: FIRST, toIndex: 99 }], ctx());
    expect(result.errors).toEqual([]);
    expect(result.timeline.tracks[0]!.clips.map((c) => c.id)).toEqual([SECOND, THIRD, FIRST]);
  });

  it('shortens the timeline when a clip is sped up', () => {
    const result = applyOps(makeCoarseTimeline(), [{ op: 'setSpeed', clipId: SECOND, speed: 4 }], ctx());
    const clips = result.timeline.tracks[0]!.clips;
    expect(outputDuration(clips[1]!)).toBe(S(3));
    expect(clipEnd(clips[2]!)).toBe(S(19));
  });

  it('merges a partial audio update', () => {
    const result = applyOps(makeCoarseTimeline(), [{ op: 'setAudio', clipId: FIRST, audio: { mute: true } }], ctx());
    const clip = findClip(result.timeline, FIRST)!.clip;
    expect(clip.audio).toEqual({ gain: 1, mute: true });
  });

  it('rejects a duplicate effect id on the same clip', () => {
    const effect = kenBurns('fx_zoom', S(8), { scale: 1 }, { scale: 1.2 });
    const result = applyOps(
      makeCoarseTimeline(),
      [
        { op: 'addEffect', clipId: FIRST, effect },
        { op: 'addEffect', clipId: FIRST, effect },
      ],
      ctx(),
    );
    expect(result.applied).toHaveLength(1);
    expect(result.errors[0]!.message).toMatch(/already on clip/);
  });

  it('removes an effect by id', () => {
    const effect = kenBurns('fx_zoom', S(8), { scale: 1 }, { scale: 1.2 });
    const result = applyOps(
      makeCoarseTimeline(),
      [
        { op: 'addEffect', clipId: FIRST, effect },
        { op: 'removeEffect', clipId: FIRST, effectId: 'fx_zoom' },
      ],
      ctx(),
    );
    expect(result.errors).toEqual([]);
    expect(findClip(result.timeline, FIRST)!.clip.effects).toEqual([]);
  });
});

describe('insertClip', () => {
  it('restores footage the coarse pass dropped', () => {
    const timeline = makeCoarseTimeline();
    const trackId = timeline.tracks[0]!.id;

    const result = applyOps(
      timeline,
      [
        {
          op: 'insertClip',
          trackId,
          sourceId: 'src_take1',
          sourceIn: S(10),
          sourceOut: S(14),
          atIndex: 1,
          rationale: 'the beat after the intro reads as a pause, not dead air',
        },
      ],
      ctx(),
    );

    expect(result.errors).toEqual([]);
    const clips = result.timeline.tracks[0]!.clips;
    expect(clips).toHaveLength(4);
    expect(clips[1]!.sourceIn).toBe(S(10));
    expect(clips[1]!.start).toBe(S(8));
    expect(clips[2]!.start).toBe(S(12));
  });

  it('rejects an unknown source when sources are supplied', () => {
    const timeline = makeCoarseTimeline();
    const result = applyOps(
      timeline,
      [
        {
          op: 'insertClip',
          trackId: timeline.tracks[0]!.id,
          sourceId: 'src_nope',
          sourceIn: 0,
          sourceOut: S(1),
        },
      ],
      ctx(),
    );
    expect(result.errors[0]!.message).toMatch(/no source src_nope/);
  });
});
