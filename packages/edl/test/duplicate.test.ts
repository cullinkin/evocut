import { describe, expect, it } from 'vitest';
import { applyOps } from '../src/apply.js';
import { createClip, createTimeline, createTrack } from '../src/factory.js';
import { makeIdFactory } from '../src/schema/common.js';
import { outputDuration } from '../src/schema/clip.js';
import { timelineDuration } from '../src/schema/timeline.js';
import { secondsToMicros as S } from '../src/time.js';
import type { Source } from '../src/schema/source.js';
import type { Timeline } from '../src/schema/timeline.js';

/**
 * Duplicating a clip.
 *
 * The reason it is its own op rather than an `insertClip` at the right index: a teaser at
 * the head of a video is the *finished* shot appearing twice — its grade, its speed, its
 * framing — not the same seconds of raw footage a second time. Everything below is about
 * that distinction, and about the copy being a genuinely separate clip afterwards.
 */
const source: Source = {
  id: 'src_take',
  locator: { kind: 'opfs', path: 'take.mp4' },
  name: 'take.mp4',
  duration: S(600),
};

function timeline(): Timeline {
  const d = { newId: makeIdFactory('t') };
  const clips = [
    createClip({ sourceId: source.id, sourceIn: 0, sourceOut: S(4) }, d),
    createClip({ sourceId: source.id, sourceIn: S(10), sourceOut: S(16) }, d),
    createClip({ sourceId: source.id, sourceIn: S(30), sourceOut: S(33) }, d),
  ];
  return createTimeline({ tracks: [createTrack({ kind: 'video', clips }, d)] }, d);
}

const clipsOf = (t: Timeline) => t.tracks[0]!.clips;
const ctx = { sources: [source], newId: makeIdFactory('n') };

describe('duplicateClip', () => {
  it('puts the copy right after the original by default', () => {
    const before = timeline();
    const target = clipsOf(before)[1]!;
    const { timeline: after, errors } = applyOps(before, [{ op: 'duplicateClip', clipId: target.id }], ctx);

    expect(errors).toEqual([]);
    expect(clipsOf(after)).toHaveLength(4);
    expect(clipsOf(after)[1]!.id).toBe(target.id);
    expect(clipsOf(after)[2]!.sourceIn).toBe(target.sourceIn);
    expect(clipsOf(after)[2]!.sourceOut).toBe(target.sourceOut);
  });

  it('puts it at the head when asked, which is what a teaser is', () => {
    const before = timeline();
    const target = clipsOf(before)[2]!;
    const { timeline: after } = applyOps(
      before,
      [{ op: 'duplicateClip', clipId: target.id, at: 'start' }],
      ctx,
    );

    expect(clipsOf(after)[0]!.sourceIn).toBe(target.sourceIn);
    expect(clipsOf(after)[0]!.start).toBe(0);
    // And everything else moved along rather than being overwritten.
    expect(clipsOf(after)).toHaveLength(4);
    expect(clipsOf(after)[1]!.id).toBe(clipsOf(before)[0]!.id);
  });

  it('carries the grade, the speed and the framing — the point of copying it', () => {
    const before = timeline();
    const target = clipsOf(before)[0]!;
    const dressed = applyOps(
      before,
      [
        { op: 'setSpeed', clipId: target.id, speed: 2 },
        { op: 'setColor', clipId: target.id, color: { exposure: 0.4, brilliance: 0, contrast: 0, saturation: 0.2, warmth: 0, tint: 0 } },
        {
          op: 'addEffect',
          clipId: target.id,
          effect: {
            id: 'fx_push',
            type: 'transform',
            enabled: true,
            keyframes: [{ t: 0, value: { scale: 1, x: 0, y: 0, rotation: 0 }, easing: 'linear' }],
          },
        },
      ],
      ctx,
    ).timeline;

    const after = applyOps(dressed, [{ op: 'duplicateClip', clipId: target.id }], ctx).timeline;
    const copy = clipsOf(after)[1]!;

    expect(copy.speed).toBe(2);
    expect(copy.effects.map((effect) => effect.type).sort()).toEqual(['color', 'transform']);
    const colour = copy.effects.find((effect) => effect.type === 'color');
    expect(colour?.type === 'color' && colour.value.exposure).toBe(0.4);
  });

  it('gives the copy its own ids, so editing one does not edit the other', () => {
    const before = applyOps(
      timeline(),
      [
        {
          op: 'addEffect',
          clipId: clipsOf(timeline())[0]!.id,
          effect: {
            id: 'fx_one',
            type: 'transform',
            enabled: true,
            keyframes: [{ t: 0, value: { scale: 1.2, x: 0, y: 0, rotation: 0 }, easing: 'linear' }],
          },
        },
      ],
      ctx,
    ).timeline;

    const target = clipsOf(before)[0]!;
    const after = applyOps(before, [{ op: 'duplicateClip', clipId: target.id }], ctx).timeline;
    const [original, copy] = clipsOf(after);

    expect(copy!.id).not.toBe(original!.id);
    // A shared effect id is a `removeEffect` that silently hits both clips.
    expect(copy!.effects[0]!.id).not.toBe(original!.effects[0]!.id);

    // And removing it from the copy leaves the original alone.
    const trimmed = applyOps(
      after,
      [{ op: 'removeEffect', clipId: copy!.id, effectId: copy!.effects[0]!.id }],
      ctx,
    ).timeline;
    expect(clipsOf(trimmed)[0]!.effects).toHaveLength(1);
    expect(clipsOf(trimmed)[1]!.effects).toHaveLength(0);
  });

  it('lengthens the edit by exactly the clip that was copied', () => {
    const before = timeline();
    const target = clipsOf(before)[1]!;
    const after = applyOps(before, [{ op: 'duplicateClip', clipId: target.id }], ctx).timeline;

    expect(timelineDuration(after) - timelineDuration(before)).toBe(outputDuration(target));
  });

  it('leaves no gap: the copy is laid out against its neighbours like any other clip', () => {
    const before = timeline();
    const after = applyOps(
      before,
      [{ op: 'duplicateClip', clipId: clipsOf(before)[0]!.id, at: 'start' }],
      ctx,
    ).timeline;

    let at = 0;
    for (const clip of clipsOf(after)) {
      expect(clip.start).toBe(at);
      at += outputDuration(clip);
    }
  });

  it('says which clip it cannot find rather than throwing', () => {
    const { errors, timeline: after } = applyOps(
      timeline(),
      [{ op: 'duplicateClip', clipId: 'clp_nope' }],
      ctx,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/clp_nope/);
    expect(clipsOf(after)).toHaveLength(3);
  });
});
