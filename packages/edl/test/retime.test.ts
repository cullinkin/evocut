import { describe, expect, it } from 'vitest';
import { applyOps } from '../src/apply.js';
import { sampleTransform } from '../src/interpolate.js';
import { COARSE_CLIP_IDS, makeCoarseTimeline, testDeps } from './fixtures.js';
import type { Effect, Timeline, TransformValue } from '../src/index.js';

/**
 * A keyframe is a moment in the footage, not a number on a clip.
 *
 * Reported from a real session, and confirmed in its log: eight keyframes committed onto a
 * shot at 14:49:18, a drag on the clip's head at 14:49:42 that moved `sourceIn` five frames
 * earlier — and every move stayed where it was, which means every move was now five frames
 * late against the gesture it was cut to. "I did a drag at the beginning of the clip and it
 * seemed to shift all of the keyframes."
 *
 * Keyframes are stored in clip-*output* time, which is exactly the coordinate a trim or a
 * speed change moves. So the numbers have to move with it. The property is easy to state
 * and is what every test here asserts: **the framing on a given frame of recording does not
 * change** when the clip's edges or its speed do.
 */
const FRAME = 1_000_000 / 30;
const ctx = () => testDeps('r');
const FIRST = COARSE_CLIP_IDS[0];

function clipOf(timeline: Timeline, clipId: string) {
  return timeline.tracks[0]!.clips.find((c) => c.id === clipId)!;
}

function moveOf(timeline: Timeline, clipId: string) {
  return clipOf(timeline, clipId).effects.find(
    (e): e is Extract<Effect, { type: 'transform' }> => e.type === 'transform',
  );
}

/** Where a clip's keyframes are, in the source recording rather than in the clip. */
function inSource(timeline: Timeline, clipId: string): Array<{ sourceUs: number; scale: number }> {
  const clip = clipOf(timeline, clipId);
  return (moveOf(timeline, clipId)?.keyframes ?? []).map((keyframe) => ({
    sourceUs: Math.round(clip.sourceIn + keyframe.t * clip.speed),
    scale: keyframe.value.scale,
  }));
}

/** The framing shown for a given moment of the recording. */
function framingAt(timeline: Timeline, clipId: string, sourceUs: number): TransformValue {
  const clip = clipOf(timeline, clipId);
  return sampleTransform(moveOf(timeline, clipId)?.keyframes ?? [], (sourceUs - clip.sourceIn) / clip.speed);
}

/** A clip with a push-in on it: wide at frame 2, in by frame 6, held to frame 24. */
function withMove() {
  const start = makeCoarseTimeline();
  const before = clipOf(start, FIRST);
  const { timeline } = applyOps(
    start,
    [
      {
        op: 'setTransform',
        clipId: FIRST,
        keyframes: [2, 6, 24].map((frame, index) => ({
          t: Math.round(frame * FRAME),
          value: { scale: [1, 2.5, 2.5][index]!, x: 0, y: 0, rotation: 0 },
          easing: 'easeInOut' as const,
        })),
      },
    ],
    ctx(),
  );
  return { timeline, before };
}

describe('trimming carries the keyframes', () => {
  it('holds every move on the frame it was placed on when the head is extended', () => {
    /*
      The reported case, with its own shape: `sourceIn` moved five frames earlier on a clip
      that already carried a finished move.
    */
    const { timeline, before } = withMove();
    const wanted = inSource(timeline, FIRST);

    const { timeline: trimmed, errors } = applyOps(
      timeline,
      [{ op: 'trim', clipId: FIRST, sourceIn: before.sourceIn - Math.round(5 * FRAME) }],
      ctx(),
    );

    expect(errors).toEqual([]);
    expect(inSource(trimmed, FIRST)).toEqual(wanted);
    // Which is the same statement from the other side: the same recording shows the same
    // framing, before and after.
    for (const { sourceUs } of wanted) {
      expect(framingAt(trimmed, FIRST, sourceUs)).toEqual(framingAt(timeline, FIRST, sourceUs));
    }
  });

  it('holds them when the head is trimmed in, too', () => {
    const { timeline, before } = withMove();
    const wanted = inSource(timeline, FIRST);

    const { timeline: trimmed } = applyOps(
      timeline,
      [{ op: 'trim', clipId: FIRST, sourceIn: before.sourceIn + Math.round(1 * FRAME) }],
      ctx(),
    );
    // The first key is now one frame before the clip starts, so it is replaced by the value
    // it was holding at the new edge — the rest are untouched.
    expect(inSource(trimmed, FIRST).slice(1)).toEqual(wanted.slice(1));
  });

  it('leaves them alone when only the tail moves', () => {
    const { timeline, before } = withMove();
    const { timeline: trimmed } = applyOps(
      timeline,
      [{ op: 'trim', clipId: FIRST, sourceOut: before.sourceOut - Math.round(2 * FRAME) }],
      ctx(),
    );
    expect(inSource(trimmed, FIRST)).toEqual(inSource(timeline, FIRST));
  });

  it('pins the framing at a new edge rather than snapping back', () => {
    /*
      Trimming into the middle of a push-in must not restore the wide shot. The value the
      move had reached at the new edge is kept there, so the shot starts already pushed in —
      which is what the picture was doing a frame earlier, and what a cut into a move looks
      like everywhere else.
    */
    const { timeline, before } = withMove();
    const intoTheMove = before.sourceIn + Math.round(4 * FRAME);
    const wanted = framingAt(timeline, FIRST, intoTheMove);

    const { timeline: trimmed } = applyOps(
      timeline,
      [{ op: 'trim', clipId: FIRST, sourceIn: intoTheMove }],
      ctx(),
    );
    const keys = moveOf(trimmed, FIRST)!.keyframes;

    expect(keys[0]!.t).toBe(0);
    expect(keys[0]!.value.scale).toBeCloseTo(wanted.scale, 3);
    expect(wanted.scale).toBeGreaterThan(1);
    expect(wanted.scale).toBeLessThan(2.5);
  });

  it('keeps a move that is entirely trimmed away as the framing it ended on', () => {
    const { timeline, before } = withMove();
    const { timeline: trimmed } = applyOps(
      timeline,
      [{ op: 'trim', clipId: FIRST, sourceIn: before.sourceIn + Math.round(30 * FRAME) }],
      ctx(),
    );
    // One key, holding the size the push-in had reached: the shot stays where the move left
    // it rather than jumping back to wide.
    const keys = moveOf(trimmed, FIRST)!.keyframes;
    expect(keys).toHaveLength(1);
    expect(keys[0]!.value.scale).toBe(2.5);
  });
});

describe('a speed change carries them too', () => {
  it('stretches the move so it stays on the same footage', () => {
    const { timeline } = withMove();
    const wanted = inSource(timeline, FIRST);

    const { timeline: slowed } = applyOps(timeline, [{ op: 'setSpeed', clipId: FIRST, speed: 0.5 }], ctx());
    for (const { sourceUs, scale } of wanted) {
      expect(framingAt(slowed, FIRST, sourceUs).scale).toBeCloseTo(scale, 3);
    }
  });

  it('and when it is sped up', () => {
    const { timeline } = withMove();
    const wanted = inSource(timeline, FIRST);

    const { timeline: fast } = applyOps(timeline, [{ op: 'setSpeed', clipId: FIRST, speed: 2 }], ctx());
    for (const { sourceUs, scale } of wanted) {
      expect(framingAt(fast, FIRST, sourceUs).scale).toBeCloseTo(scale, 3);
    }
  });
});

describe('nothing else is disturbed', () => {
  it('leaves a grade alone, which has no time in it to move', () => {
    const { timeline: graded } = applyOps(
      makeCoarseTimeline(),
      [
        {
          op: 'setColor',
          clipId: FIRST,
          color: { exposure: 0, brilliance: 0, contrast: 0.05, saturation: 0.3, warmth: 0, tint: 0 },
        },
      ],
      ctx(),
    );
    const { timeline: trimmed } = applyOps(
      graded,
      [{ op: 'trim', clipId: FIRST, sourceIn: clipOf(graded, FIRST).sourceIn + 100_000 }],
      ctx(),
    );

    const colour = (t: Timeline) => clipOf(t, FIRST).effects.find((e) => e.type === 'color');
    expect(colour(trimmed)).toEqual(colour(graded));
  });

  it('is a no-op for a clip with no effects', () => {
    const start = makeCoarseTimeline();
    const { timeline: trimmed, errors } = applyOps(
      start,
      [{ op: 'trim', clipId: FIRST, sourceIn: clipOf(start, FIRST).sourceIn + 100_000 }],
      ctx(),
    );
    expect(errors).toEqual([]);
    expect(clipOf(trimmed, FIRST).effects).toEqual([]);
  });
});
