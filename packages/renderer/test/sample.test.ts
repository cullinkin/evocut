import { describe, expect, it } from 'vitest';
import {
  applyOps,
  createClip,
  createTimeline,
  createTrack,
  kenBurns,
  makeIdFactory,
  secondsToMicros as S,
} from '@evocut/edl';
import { planDecode, sampleTimeline } from '../src/sample.js';

function deps() {
  return { newId: makeIdFactory('r') };
}

function timeline() {
  const d = deps();
  const clips = [
    createClip({ sourceId: 'src_a', sourceIn: S(2), sourceOut: S(10) }, d),
    createClip({ sourceId: 'src_a', sourceIn: S(18), sourceOut: S(30) }, d),
  ];
  return createTimeline({ tracks: [createTrack({ kind: 'video', clips }, d)] }, d);
}

describe('sampleTimeline', () => {
  it('maps output time back to the right source time across a cut', () => {
    const tl = timeline();
    // 1s into the first clip is 3s into the source; 1s into the second is 19s.
    expect(sampleTimeline(tl, S(1)).layers[0]!.sourceTime).toBe(S(3));
    expect(sampleTimeline(tl, S(9)).layers[0]!.sourceTime).toBe(S(19));
  });

  it('treats clip boundaries as half-open', () => {
    const tl = timeline();
    // Exactly at 8s the first clip has ended and the second owns the frame. An
    // inclusive end here is how editors end up rendering one duplicated frame per cut.
    expect(sampleTimeline(tl, S(8)).layers[0]!.sourceTime).toBe(S(18));
    expect(sampleTimeline(tl, S(20)).layers).toEqual([]);
  });

  it('reports nothing to draw past the end', () => {
    expect(sampleTimeline(timeline(), S(999)).layers).toHaveLength(0);
  });

  it('samples animated framing at the sampled instant', () => {
    const tl = timeline();
    const clipId = tl.tracks[0]!.clips[0]!.id;
    const withZoom = applyOps(
      tl,
      [{ op: 'addEffect', clipId, effect: kenBurns('fx_push', S(8), { scale: 1 }, { scale: 2 }) }],
      deps(),
    ).timeline;

    expect(sampleTimeline(withZoom, 0).layers[0]!.transform.scale).toBeCloseTo(1, 6);
    expect(sampleTimeline(withZoom, S(4)).layers[0]!.transform.scale).toBeCloseTo(1.5, 6);
  });

  it('accounts for speed in both the source time and the effect clock', () => {
    const tl = timeline();
    const clipId = tl.tracks[0]!.clips[0]!.id;
    const fast = applyOps(tl, [{ op: 'setSpeed', clipId, speed: 2 }], deps()).timeline;

    // The clip is now 4s of output covering 8s of source.
    expect(sampleTimeline(fast, S(1)).layers[0]!.sourceTime).toBe(S(4));
    expect(sampleTimeline(fast, S(4)).layers[0]!.clip.sourceId).toBe('src_a');
    expect(sampleTimeline(fast, S(4)).layers[0]!.sourceTime).toBe(S(18));
  });

  it('folds mute and gain into one number', () => {
    const tl = timeline();
    const clipId = tl.tracks[0]!.clips[0]!.id;
    const quiet = applyOps(tl, [{ op: 'setAudio', clipId, audio: { gain: 0.5 } }], deps()).timeline;
    expect(sampleTimeline(quiet, S(1)).layers[0]!.gain).toBe(0.5);

    const muted = applyOps(tl, [{ op: 'setAudio', clipId, audio: { mute: true } }], deps()).timeline;
    expect(sampleTimeline(muted, S(1)).layers[0]!.gain).toBe(0);
  });

  it('skips disabled clips entirely', () => {
    const tl = timeline();
    const clipId = tl.tracks[0]!.clips[0]!.id;
    const off = applyOps(tl, [{ op: 'setEnabled', clipId, enabled: false }], deps()).timeline;
    // The second clip has rippled to zero, so time 0 is now the second clip's head.
    expect(off.tracks[0]!.clips[1]!.start).toBe(0);
    expect(sampleTimeline(off, 0).layers[0]!.sourceTime).toBe(S(18));
  });
});

describe('planDecode', () => {
  it('emits one segment per enabled clip, in output order', () => {
    const segments = planDecode(timeline());
    expect(segments.map((s) => s.outStart)).toEqual([0, S(8)]);
    expect(segments.map((s) => s.frameCount)).toEqual([240, 360]);
  });

  it('halves the frame count at double speed', () => {
    const tl = timeline();
    const clipId = tl.tracks[0]!.clips[0]!.id;
    const fast = applyOps(tl, [{ op: 'setSpeed', clipId, speed: 2 }], deps()).timeline;
    expect(planDecode(fast)[0]!.frameCount).toBe(120);
  });
});
