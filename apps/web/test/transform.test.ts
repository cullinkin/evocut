import { describe, expect, it } from 'vitest';
import { IDENTITY, keyframeAt, sameFrame, snapToFrame, valueAt, writeAt } from '../src/Transform.tsx';

/**
 * Where a keyframe goes, and when two of them are one.
 *
 * Reported from a real session, at the zoom where a third of a second fills a phone:
 *
 *   "They don't seem to drop where I tell them to, instead they are offset a bit, and then
 *   if I try moving along the timeline, zooming in to drop another, it just doesn't. The
 *   whole clip seems to be set at that zoom then instead of in a new keyframe."
 *
 * Both halves came from one constant. Two keyframes within 66ms of each other counted as
 * the same keyframe, which was a sliver of the screen at the zoom that number was written
 * for and is a fifth of the screen now — so an adjustment made after a visibly long move
 * silently rewrote the key you had just placed, and one key is a static reframe of the
 * whole shot rather than a move.
 */

/** 30fps and 60fps, in microseconds. */
const FRAME_30 = 1_000_000 / 30;
const FRAME_60 = 1_000_000 / 60;

const key = (t: number, scale: number) => ({ t, value: { ...IDENTITY, scale }, easing: 'easeInOut' as const });

describe('two keyframes are the same one only within a frame', () => {
  it('does not merge keys a visible distance apart', () => {
    /*
      The exact failure. At full zoom a phone shows a third of a second, so 66ms — the old
      tolerance — is a fifth of the screen: you move the lane a long way, adjust, and the
      adjustment lands on the key you already made.
    */
    const keys = [key(1_000_000, 1.4)];
    const next = writeAt(keys, 1_040_000, { ...IDENTITY, scale: 2.2 }, FRAME_30);
    expect(next).toHaveLength(2);
    expect(next.map((k) => k.value.scale)).toEqual([1.4, 2.2]);
  });

  it('does merge two writes on the same frame', () => {
    // Which is what makes dragging a slider one decision rather than thirty: every tick of
    // the drag rewrites the key at this frame instead of leaving a trail of them.
    const keys = [key(1_000_000, 1.4)];
    const next = writeAt(keys, 1_000_000 + FRAME_30 / 3, { ...IDENTITY, scale: 2.2 }, FRAME_30);
    expect(next).toHaveLength(1);
    expect(next[0]!.value.scale).toBe(2.2);
    // And keeps the original's time, so a slider drag cannot walk a key forwards.
    expect(next[0]!.t).toBe(1_000_000);
  });

  it('scales with the frame rate', () => {
    const keys = [key(1_000_000, 1.4)];
    // 20ms apart: two distinct frames at 60fps, the same frame at 30.
    expect(writeAt(keys, 1_020_000, { ...IDENTITY, scale: 2 }, FRAME_60)).toHaveLength(2);
    expect(writeAt(keys, 1_010_000, { ...IDENTITY, scale: 2 }, FRAME_30)).toHaveLength(1);
    // Half a frame, in microseconds: 16.7ms at 30fps.
    expect(sameFrame(FRAME_30)).toBeCloseTo(16_667, 0);
  });

  it('finds a key by frame rather than by exact microsecond', () => {
    const keys = [key(1_000_000, 1.4)];
    expect(keyframeAt(keys, 1_000_000, FRAME_30)).toBe(keys[0]);
    expect(keyframeAt(keys, 1_000_010, FRAME_30)).toBe(keys[0]);
    expect(keyframeAt(keys, 1_100_000, FRAME_30)).toBe(null);
  });
});

describe('keys land on frames', () => {
  it('rounds to the nearest frame boundary', () => {
    expect(snapToFrame(0, FRAME_30)).toBe(0);
    expect(snapToFrame(33_000, FRAME_30)).toBe(33_333);
    expect(snapToFrame(50_000, FRAME_30)).toBe(66_667);
    expect(snapToFrame(1_000_000, FRAME_30)).toBe(1_000_000);
  });

  it('survives a rate it cannot use', () => {
    expect(snapToFrame(12_345, 0)).toBe(12_345);
    expect(snapToFrame(12_345, Number.POSITIVE_INFINITY)).toBe(12_345);
  });
});

describe('building a move', () => {
  it('turns three adjustments at three moments into three keys', () => {
    // The gesture the panel exists for: drop, move, adjust, move, adjust.
    let keys = writeAt([], 0, { ...IDENTITY, scale: 1 }, FRAME_30);
    keys = writeAt(keys, 500_000, { ...IDENTITY, scale: 1.6 }, FRAME_30);
    keys = writeAt(keys, 1_000_000, { ...IDENTITY, scale: 2.4 }, FRAME_30);

    expect(keys.map((k) => k.t)).toEqual([0, 500_000, 1_000_000]);
    // And it is a move: the framing halfway between two keys is between their values.
    const middle = valueAt(keys, 750_000);
    expect(middle.scale).toBeGreaterThan(1.6);
    expect(middle.scale).toBeLessThan(2.4);
  });

  it('is a static reframe with one key, and says so by holding still', () => {
    const keys = writeAt([], 400_000, { ...IDENTITY, scale: 2 }, FRAME_30);
    expect(valueAt(keys, 0).scale).toBe(2);
    expect(valueAt(keys, 5_000_000).scale).toBe(2);
  });

  it('keeps the list in order however it is written', () => {
    let keys = writeAt([], 1_000_000, { ...IDENTITY, scale: 3 }, FRAME_30);
    keys = writeAt(keys, 200_000, { ...IDENTITY, scale: 1 }, FRAME_30);
    keys = writeAt(keys, 600_000, { ...IDENTITY, scale: 2 }, FRAME_30);
    expect(keys.map((k) => k.t)).toEqual([200_000, 600_000, 1_000_000]);
  });
});
