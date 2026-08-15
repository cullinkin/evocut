import { describe, expect, it } from 'vitest';
import { trimBounds } from '../src/schema/clip.js';
import { applyOps } from '../src/apply.js';
import { findClip } from '../src/schema/timeline.js';
import { COARSE_CLIP_IDS, makeCoarseTimeline, makeSource, S } from './fixtures.js';

const sources = [makeSource()];
const ctx = () => ({ sources });
const [FIRST, SECOND] = COARSE_CLIP_IDS;

describe('trimBounds', () => {
  it('reports the raw footage available on each side', () => {
    // Clip runs 2s–10s inside a 60s source.
    const bounds = trimBounds({ sourceIn: S(2), sourceOut: S(10) }, S(60));
    expect(bounds.headroom).toEqual({ head: S(2), tail: S(50) });
    expect(bounds.inMin).toBe(0);
    expect(bounds.outMax).toBe(S(60));
  });

  it('keeps the edges from crossing', () => {
    const bounds = trimBounds({ sourceIn: S(2), sourceOut: S(10) }, S(60), S(1));
    expect(bounds.inMax).toBe(S(9));
    expect(bounds.outMin).toBe(S(3));
  });

  it('reports no headroom for a clip that already spans the source', () => {
    const bounds = trimBounds({ sourceIn: 0, sourceOut: S(60) }, S(60));
    expect(bounds.headroom).toEqual({ head: 0, tail: 0 });
  });

  it('does not demand a minimum longer than the source', () => {
    const bounds = trimBounds({ sourceIn: 0, sourceOut: 50_000 }, 50_000);
    expect(bounds.outMin).toBeLessThanOrEqual(50_000);
    expect(bounds.inMax).toBeGreaterThanOrEqual(0);
  });
});

describe('trimming through the op engine', () => {
  it('extends a clip backwards into footage the coarse pass cut', () => {
    const timeline = makeCoarseTimeline();
    const bounds = trimBounds(findClip(timeline, SECOND)!.clip, S(60));
    // The second clip starts at 18s, so there is real footage behind it.
    expect(bounds.headroom.head).toBe(S(18));

    const result = applyOps(timeline, [{ op: 'trim', clipId: SECOND, sourceIn: S(15) }], ctx());
    expect(result.errors).toEqual([]);
    expect(findClip(result.timeline, SECOND)!.clip.sourceIn).toBe(S(15));
    // Extending lengthens the clip, so everything after it moves right.
    expect(findClip(result.timeline, SECOND)!.clip.start).toBe(S(8));
    expect(result.timeline.tracks[0]!.clips[2]!.start).toBe(S(23));
  });

  it('refuses to extend past the end of the source', () => {
    const timeline = makeCoarseTimeline();
    const bounds = trimBounds(findClip(timeline, FIRST)!.clip, S(60));
    const result = applyOps(
      timeline,
      [{ op: 'trim', clipId: FIRST, sourceOut: bounds.outMax + 1 }],
      ctx(),
    );
    expect(result.applied).toEqual([]);
    expect(result.errors[0]!.message).toMatch(/runs past the end of source/);
  });

  it('accepts a trim landing exactly on the reported bounds', () => {
    // The UI clamps drags to these numbers, so an off-by-one here would make the
    // handle refuse to reach its own stop.
    const timeline = makeCoarseTimeline();
    const bounds = trimBounds(findClip(timeline, FIRST)!.clip, S(60));

    const result = applyOps(
      timeline,
      [{ op: 'trim', clipId: FIRST, sourceIn: bounds.inMin, sourceOut: bounds.outMax }],
      ctx(),
    );
    expect(result.errors).toEqual([]);
    const clip = findClip(result.timeline, FIRST)!.clip;
    expect(clip.sourceIn).toBe(0);
    expect(clip.sourceOut).toBe(S(60));
  });

  it('accepts a trim collapsed to the minimum length', () => {
    const timeline = makeCoarseTimeline();
    const bounds = trimBounds(findClip(timeline, FIRST)!.clip, S(60));
    const result = applyOps(timeline, [{ op: 'trim', clipId: FIRST, sourceIn: bounds.inMax }], ctx());

    expect(result.errors).toEqual([]);
    expect(findClip(result.timeline, FIRST)!.clip.sourceIn).toBe(bounds.inMax);
  });
});
