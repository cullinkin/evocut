import { describe, expect, it } from 'vitest';
import {
  applyOps,
  createClip,
  createTimeline,
  createTrack,
  makeIdFactory,
  secondsToMicros as S,
  type Timeline,
} from '@evocut/edl';
import { mixdown, planAudio, type ClipAudio, type OfflineAudio } from '../src/audio.js';

function deps() {
  return { newId: makeIdFactory('a') };
}

function timeline(): Timeline {
  const d = deps();
  const clips = [
    createClip({ sourceId: 'src_a', sourceIn: S(2), sourceOut: S(10) }, d),
    createClip({ sourceId: 'src_a', sourceIn: S(18), sourceOut: S(30) }, d),
  ];
  return createTimeline({ tracks: [createTrack({ kind: 'video', clips }, d)] }, d);
}

describe('planAudio', () => {
  it('places each clip at its output time, reading from its source time', () => {
    expect(planAudio(timeline()).map((s) => [s.at, s.offset, s.duration])).toEqual([
      [0, 2, 8],
      [8, 18, 12],
    ]);
  });

  it('reads the same amount of source at any speed', () => {
    const tl = timeline();
    const clipId = tl.tracks[0]!.clips[0]!.id;
    const fast = applyOps(tl, [{ op: 'setSpeed', clipId, speed: 2 }], deps()).timeline;
    const [first, second] = planAudio(fast);

    // The buffer source is asked for all 8 seconds of source and told to play it at 2x,
    // which occupies 4 seconds of output — so the next clip starts at 4, not 8.
    expect(first!.duration).toBe(8);
    expect(first!.rate).toBe(2);
    expect(second!.at).toBe(4);
  });

  it('leaves out everything that makes no sound', () => {
    const tl = timeline();
    const [a, b] = tl.tracks[0]!.clips;
    expect(planAudio(applyOps(tl, [{ op: 'setAudio', clipId: a!.id, audio: { mute: true } }], deps()).timeline))
      .toHaveLength(1);
    expect(planAudio(applyOps(tl, [{ op: 'setEnabled', clipId: b!.id, enabled: false }], deps()).timeline))
      .toHaveLength(1);
    expect(planAudio(applyOps(tl, [{ op: 'setAudio', clipId: a!.id, audio: { gain: 0 } }], deps()).timeline))
      .toHaveLength(1);
  });

  it('ignores muted and overlay tracks', () => {
    const tl = timeline();
    expect(planAudio({ ...tl, tracks: [{ ...tl.tracks[0]!, muted: true }] })).toEqual([]);
    expect(planAudio({ ...tl, tracks: [{ ...tl.tracks[0]!, kind: 'overlay' }] })).toEqual([]);
  });

  it('puts volume keyframes on the output clock, not the clip clock', () => {
    const tl = timeline();
    const clipId = tl.tracks[0]!.clips[1]!.id; // starts at 8s on the output timeline
    const faded = applyOps(
      tl,
      [
        {
          op: 'addEffect',
          clipId,
          effect: {
            id: 'fx_fade',
            type: 'volume',
            enabled: true,
            keyframes: [
              { t: 0, value: 0, easing: 'linear' },
              { t: S(1), value: 1, easing: 'linear' },
            ],
          },
        },
      ],
      deps(),
    ).timeline;

    const segment = planAudio(faded)[1]!;
    expect(segment.ramps).toEqual([
      { at: 8, value: 0, step: false },
      { at: 9, value: 1, step: false },
    ]);
  });

  it('marks a held keyframe as a step rather than a ramp', () => {
    const tl = timeline();
    const clipId = tl.tracks[0]!.clips[0]!.id;
    const ducked = applyOps(
      tl,
      [
        {
          op: 'addEffect',
          clipId,
          effect: {
            id: 'fx_duck',
            type: 'volume',
            enabled: true,
            keyframes: [
              { t: 0, value: 1, easing: 'hold' },
              { t: S(2), value: 0.2, easing: 'linear' },
            ],
          },
        },
      ],
      deps(),
    ).timeline;

    expect(planAudio(ducked)[0]!.ramps.map((r) => r.step)).toEqual([true, false]);
  });
});

/** Enough of an OfflineAudioContext to record what was scheduled against it. */
function fakeContext() {
  const scheduled: Array<{ at: number; offset: number; duration: number; rate: number }> = [];
  const automation: Array<{ kind: string; value: number; at: number }> = [];
  const gains: number[] = [];
  const buffer = { length: 4, numberOfChannels: 2 } as unknown as AudioBuffer;

  const context = {
    sampleRate: 48_000,
    destination: {} as AudioNode,
    createBufferSource() {
      const node = {
        buffer: null as AudioBuffer | null,
        playbackRate: { value: 1 },
        connect() {},
        start(at: number, offset: number, duration: number) {
          scheduled.push({ at, offset, duration, rate: node.playbackRate.value });
        },
      };
      return node as unknown as AudioBufferSourceNode;
    },
    createGain() {
      const gain = {
        value: 1,
        setValueAtTime(value: number, at: number) {
          automation.push({ kind: 'set', value, at });
        },
        linearRampToValueAtTime(value: number, at: number) {
          automation.push({ kind: 'ramp', value, at });
        },
      };
      // Read at connect time rather than on assignment: the caller sets `value` before
      // scheduling anything, so this is the settled per-clip gain.
      return { gain, connect: () => gains.push(gain.value) } as unknown as GainNode;
    },
    async startRendering() {
      return buffer;
    },
  } satisfies OfflineAudio;

  return { context, scheduled, automation, gains, buffer };
}

/**
 * Decoded audio for every clip in a timeline, as one shared whole-source buffer.
 *
 * The shape the fallback path produces: one buffer covering the take, `startUs: 0`, keyed
 * per clip. The demuxed path keys the same map with per-clip windows instead, which is
 * what the `startUs` test below covers.
 */
function wholeSource(tl: Timeline, startUs = 0): Map<string, ClipAudio> {
  const buffer = { length: 48_000 * 30, numberOfChannels: 2, sampleRate: 48_000 } as AudioBuffer;
  return new Map(tl.tracks[0]!.clips.map((clip) => [clip.id, { buffer, startUs }]));
}

describe('mixdown', () => {
  it('schedules one buffer source per audible clip', async () => {
    const fake = fakeContext();
    const tl = timeline();
    const result = await mixdown(tl, wholeSource(tl), { createContext: () => fake.context });

    expect(result).toBe(fake.buffer);
    expect(fake.scheduled).toEqual([
      { at: 0, offset: 2, duration: 8, rate: 1 },
      { at: 8, offset: 18, duration: 12, rate: 1 },
    ]);
  });

  it('carries the clip gain onto its gain node and folds it into the ramps', async () => {
    const tl = timeline();
    const clipId = tl.tracks[0]!.clips[0]!.id;
    const quiet = applyOps(tl, [{ op: 'setAudio', clipId, audio: { gain: 0.5 } }], deps()).timeline;
    const faded = applyOps(
      quiet,
      [
        {
          op: 'addEffect',
          clipId,
          effect: {
            id: 'fx_out',
            type: 'volume',
            enabled: true,
            keyframes: [
              { t: 0, value: 1, easing: 'linear' },
              { t: S(2), value: 0, easing: 'linear' },
            ],
          },
        },
      ],
      deps(),
    ).timeline;

    const fake = fakeContext();
    await mixdown(faded, wholeSource(faded), { createContext: () => fake.context });

    expect(fake.gains).toEqual([0.5, 1]);
    // The fade rides on top of the clip gain rather than replacing it, so full volume
    // inside the effect still means half volume out of the node.
    expect(fake.automation).toEqual([
      { kind: 'ramp', value: 0.5, at: 0 },
      { kind: 'ramp', value: 0, at: 2 },
    ]);
  });

  it('returns nothing when no source has decodable audio', async () => {
    const fake = fakeContext();
    expect(await mixdown(timeline(), new Map(), { createContext: () => fake.context })).toBeNull();
    expect(fake.scheduled).toEqual([]);
  });

  it('reads from the start of a window that does not begin at the source head', async () => {
    const fake = fakeContext();
    const tl = timeline();
    // Each clip's audio was decoded starting two seconds in, so the clip that reads the
    // source from 2s must now read this buffer from 0. Getting this wrong is a whole-clip
    // sync error, and it is silent in every other test because `startUs` is usually zero.
    await mixdown(tl, wholeSource(tl, S(2)), { createContext: () => fake.context });
    expect(fake.scheduled.map((s) => s.offset)).toEqual([0, 16]);
  });

  it('sizes the context to the whole timeline', async () => {
    let asked: { channels: number; frames: number; rate: number } | null = null;
    const fake = fakeContext();
    const tl = timeline();
    await mixdown(tl, wholeSource(tl), {
      createContext: (channels, frames, rate) => {
        asked = { channels, frames, rate };
        return fake.context;
      },
    });
    // Two clips, 8s and 12s of output: 20 seconds at 48kHz.
    expect(asked).toEqual({ channels: 2, frames: 48_000 * 20, rate: 48_000 });
  });
});
