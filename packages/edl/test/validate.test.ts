import { describe, expect, it } from 'vitest';
import { hasErrors, parseProject, validateProject, validateTimeline } from '../src/validate.js';
import { normalizeTimeline, snapTimelineToFrames } from '../src/normalize.js';
import { ease, sampleTransform } from '../src/interpolate.js';
import { kenBurns } from '../src/schema/effects.js';
import { FPS_29_97, frameToMicros, isFrameAligned } from '../src/time.js';
import { COARSE_CLIP_IDS, makeCoarseProject, makeCoarseTimeline, makeSource, S } from './fixtures.js';

const [FIRST, SECOND] = COARSE_CLIP_IDS;
const sources = [makeSource()];

describe('validateTimeline', () => {
  it('passes a well-formed timeline', () => {
    expect(validateTimeline(makeCoarseTimeline(), { sources })).toEqual([]);
  });

  it('reports every problem rather than the first', () => {
    // The caller is often an LLM doing a repair round; one error per pass would mean
    // one round trip per mistake.
    const timeline = makeCoarseTimeline();
    timeline.tracks[0]!.clips[0]!.sourceOut = S(1); // inverted
    timeline.tracks[0]!.clips[1]!.sourceId = 'src_missing';
    timeline.tracks[0]!.clips[2]!.sourceOut = S(90); // past the end

    const codes = validateTimeline(timeline, { sources }).map((i) => i.code);
    expect(codes).toContain('empty-clip');
    expect(codes).toContain('missing-source');
    expect(codes).toContain('out-of-bounds');
  });

  it('catches duplicate clip ids', () => {
    const timeline = makeCoarseTimeline();
    timeline.tracks[0]!.clips[1]!.id = FIRST;
    const issues = validateTimeline(timeline, { sources });
    expect(issues.some((i) => i.code === 'duplicate-clip-id')).toBe(true);
  });

  it('catches a start position that a reflow would move', () => {
    const timeline = makeCoarseTimeline();
    timeline.tracks[0]!.clips[1]!.start = S(999);
    const issues = validateTimeline(timeline, { sources });
    expect(issues.find((i) => i.code === 'position-drift')?.clipId).toBe(SECOND);
  });

  it('warns about a keyframe past the end of its clip', () => {
    const timeline = makeCoarseTimeline();
    timeline.tracks[0]!.clips[0]!.effects = [kenBurns('fx_a', S(30), { scale: 1 }, { scale: 2 })];
    const issue = validateTimeline(timeline, { sources }).find((i) => i.code === 'keyframe-past-end');
    expect(issue?.severity).toBe('warning');
  });

  it('reports frame misalignment only when asked', () => {
    const timeline = { ...makeCoarseTimeline(), frameRate: FPS_29_97 };
    expect(validateTimeline(timeline, { sources })).toEqual([]);
    // Off by default because a sub-frame cut point is real signal during the coarse
    // pass — it is the position the user's finger actually landed on.
    const issues = validateTimeline(timeline, { sources, requireFrameAlignment: true });
    expect(issues.every((i) => i.severity === 'warning')).toBe(true);
    expect(issues.some((i) => i.code === 'not-frame-aligned')).toBe(true);
  });
});

describe('validateProject', () => {
  it('warns when a post-coarse project has no frozen snapshot', () => {
    const project = { ...makeCoarseProject(), stage: 'refined' as const };
    const issue = validateProject(project).find((i) => i.code === 'missing-coarse-snapshot');
    expect(issue?.severity).toBe('warning');
  });

  it('catches a head revision that is not in the chain', () => {
    const project = { ...makeCoarseProject(), headRevisionId: 'rev_gone' };
    expect(hasErrors(validateProject(project))).toBe(true);
  });

  it('parseProject throws on semantic errors, not just shape errors', () => {
    const project = makeCoarseProject();
    project.timeline.tracks[0]!.clips[0]!.sourceOut = S(600);
    expect(() => parseProject(project)).toThrow(/out-of-bounds/);
  });
});

describe('normalize', () => {
  it('is idempotent', () => {
    const once = normalizeTimeline(makeCoarseTimeline());
    expect(normalizeTimeline(once)).toEqual(once);
  });

  it('drops zero-length clips left behind by a bad edit', () => {
    const timeline = makeCoarseTimeline();
    timeline.tracks[0]!.clips[1]!.sourceOut = timeline.tracks[0]!.clips[1]!.sourceIn;
    expect(normalizeTimeline(timeline).tracks[0]!.clips).toHaveLength(2);
  });

  it('leaves non-video tracks at their explicit positions', () => {
    // Music does not ripple when you cut a take.
    const timeline = makeCoarseTimeline();
    const [video] = timeline.tracks;
    const music = { ...video!, id: 'trk_music', kind: 'audio' as const };
    music.clips = music.clips.map((c, i) => ({ ...c, id: `clp_m${i}`, start: S(30 - i * 10) }));

    const result = normalizeTimeline({ ...timeline, tracks: [video!, music] });
    expect(result.tracks[1]!.clips.map((c) => c.start)).toEqual([S(10), S(20), S(30)]);
  });

  it('snaps cut points to frame boundaries on demand', () => {
    const timeline = { ...makeCoarseTimeline(), frameRate: FPS_29_97 };
    const snapped = snapTimelineToFrames(timeline);
    for (const clip of snapped.tracks[0]!.clips) {
      expect(isFrameAligned(clip.sourceIn, FPS_29_97)).toBe(true);
      expect(isFrameAligned(clip.sourceOut, FPS_29_97)).toBe(true);
    }
  });

  it('never collapses a clip shorter than a frame when snapping', () => {
    const timeline = { ...makeCoarseTimeline(), frameRate: FPS_29_97 };
    const clip = timeline.tracks[0]!.clips[0]!;
    clip.sourceIn = 1_000_000;
    clip.sourceOut = 1_000_100; // a tenth of a millisecond
    const snapped = snapTimelineToFrames(timeline);
    const result = snapped.tracks[0]!.clips[0]!;
    expect(result.sourceOut).toBeGreaterThan(result.sourceIn);
    expect(result.sourceOut - result.sourceIn).toBe(frameToMicros(1, FPS_29_97));
  });
});

describe('interpolation', () => {
  it('clamps outside the keyframe range', () => {
    const fx = kenBurns('fx_a', S(4), { scale: 1 }, { scale: 2 });
    expect(sampleTransform(fx.keyframes, -S(1)).scale).toBe(1);
    expect(sampleTransform(fx.keyframes, S(99)).scale).toBe(2);
  });

  it('holds the previous value across a hold keyframe', () => {
    const fx = kenBurns('fx_a', S(4), { scale: 1 }, { scale: 2 });
    fx.keyframes[0]!.easing = 'hold';
    expect(sampleTransform(fx.keyframes, S(3.9)).scale).toBe(1);
    expect(sampleTransform(fx.keyframes, S(4)).scale).toBe(2);
  });

  it('has symmetric easing curves', () => {
    for (const kind of ['linear', 'easeIn', 'easeOut', 'easeInOut'] as const) {
      expect(ease(kind, 0)).toBeCloseTo(0, 10);
      expect(ease(kind, 1)).toBeCloseTo(1, 10);
    }
    expect(ease('easeInOut', 0.5)).toBeCloseTo(0.5, 10);
  });
});
