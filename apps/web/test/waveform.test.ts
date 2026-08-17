import { describe, expect, it } from 'vitest';
import { SILENCE_DB } from '@evocut/signals';
import {
  clipAt,
  displayFloor,
  levelBetween,
  scaleDb,
  waveColumns,
  type WaveClip,
  type WaveSource,
} from '../src/waveform.ts';

/**
 * The audio lane, as arithmetic.
 *
 * What a waveform has to get right is the mapping — output time to source time, through
 * whatever trims and speed changes the clip carries — because a level drawn a second out of
 * place is worse than no level at all: it is a cue to cut in the wrong spot, and it looks
 * authoritative while it does it.
 */

/** Ten seconds of levels at a 50ms hop, so index n is n * 50ms. */
function tone(pattern: (index: number) => number, hops = 200): WaveSource {
  const loudness = Array.from({ length: hops }, (_, index) => pattern(index));
  const sorted = [...loudness].sort((a, b) => a - b);
  return {
    hopUs: 50_000,
    loudness,
    peakDb: Math.max(...loudness),
    medianDb: sorted[Math.floor(sorted.length / 2)]!,
  };
}

/** Silence everywhere except one hop, at `at` seconds. Genuine silence, not merely quiet:
 *  the display floor is derived from the recording, so a −80 dB "quiet" against a −6 dB
 *  peak is a real level and correctly draws as one. */
const spikeAt = (seconds: number) =>
  tone((i) => (i === Math.round((seconds * 1000) / 50) ? -6 : SILENCE_DB));

const clip = (over: Partial<WaveClip> = {}): WaveClip => ({
  sourceId: 'src',
  start: 0,
  sourceIn: 0,
  sourceOut: 10_000_000,
  speed: 1,
  enabled: true,
  ...over,
});

describe('the level scale', () => {
  it('puts the recording\'s own peak at the top', () => {
    expect(scaleDb(-22.5, -22.5, -76.6)).toBe(1);
    // A take shot in a quiet room and one shouted into wind both fill the lane, which is
    // the point: the display is about this recording's shape, not about full scale.
    expect(scaleDb(-60, -60, -90)).toBe(1);
  });

  it('puts the ordinary level a quarter of the way up, whatever the recording', () => {
    /*
      The fix for "very coarse, bigger histogram bars". These are the real numbers off a
      27-minute take: a peak of −22.5 and a median of −76.6, fifty-four decibels apart. The
      old flat 48 dB window put the median *below the floor*, so everything ordinary drew as
      nothing and everything else drew full height — blocks and gaps.
    */
    expect(scaleDb(-76.6, -22.5, -76.6)).toBeCloseTo(0.25, 2);
    // And a well-recorded source, where the two are close together, is not blown up to fill
    // the lane with its own noise floor.
    expect(scaleDb(-20, -6, -20)).toBeCloseTo(0.61, 2);
  });

  it('never stretches past what a small screen can show', () => {
    // A recording with almost no dynamic range must not have its floor lifted to a hair
    // below its peak, or a hiss would draw the same height as a shout.
    expect(displayFloor(-6, -7)).toBe(-42);
    // Nor may a pathological one be stretched without limit.
    expect(displayFloor(-6, -95)).toBe(-90);
    expect(displayFloor(-60, -99)).toBe(SILENCE_DB);
  });

  it('draws silence as nothing', () => {
    expect(scaleDb(SILENCE_DB, -20, -50)).toBe(0);
    expect(scaleDb(displayFloor(-20, -50), -20, -50)).toBe(0);
  });
});

describe('a column is the loudest thing in it', () => {
  it('keeps a transient that an average would bury', () => {
    /*
      The reason this is peak-per-column rather than mean. At a zoom where one column is a
      second of audio, a single loud frame among twenty quiet ones is a hit — and averaging
      turns it into the mush around it, which is exactly the information a cut is placed on.
    */
    const audio = spikeAt(3);
    expect(levelBetween(audio, 2_500_000, 3_500_000)).toBe(1);
    expect(levelBetween(audio, 4_000_000, 5_000_000)).toBe(0);
  });

  it('reads at least one hop, however narrow the column', () => {
    // Zoomed all the way in a column is thinner than 50ms, and a half-open range that
    // rounded to empty would draw gaps through a continuous sound.
    const audio = tone(() => -10);
    expect(levelBetween(audio, 1_000_000, 1_000_001)).toBe(1);
  });

  it('is silent past the end of the recording', () => {
    expect(levelBetween(spikeAt(3), 60_000_000, 61_000_000)).toBe(0);
  });
});

describe('output time to source time', () => {
  it('follows the trim', () => {
    // The clip starts four seconds into the recording, so the spike at source 6s is two
    // seconds into the clip — not six.
    const clips = [clip({ sourceIn: 4_000_000, sourceOut: 10_000_000 })];
    const audio = new Map([['src', spikeAt(6)]]);
    const columns = waveColumns({ clips, audio, fromUs: 0, usPerColumn: 1_000_000, columns: 6 });
    expect(columns[2]).toBe(1);
    expect([...columns].filter((level) => level > 0)).toHaveLength(1);
  });

  it('compresses with the speed, the way the export will', () => {
    // At 2x the clip plays six seconds of recording in three, so a spike at source 6s lands
    // one second into the clip.
    const clips = [clip({ sourceIn: 4_000_000, sourceOut: 10_000_000, speed: 2 })];
    const audio = new Map([['src', spikeAt(6)]]);
    const columns = waveColumns({ clips, audio, fromUs: 0, usPerColumn: 1_000_000, columns: 3 });
    expect(columns[1]).toBe(1);
  });

  it('follows the clip along the timeline', () => {
    const clips = [
      clip({ start: 0, sourceIn: 0, sourceOut: 2_000_000 }),
      clip({ start: 2_000_000, sourceIn: 5_000_000, sourceOut: 8_000_000 }),
    ];
    // Source 6s is one second into the second clip, which starts at output 2s.
    const audio = new Map([['src', spikeAt(6)]]);
    const columns = waveColumns({ clips, audio, fromUs: 0, usPerColumn: 1_000_000, columns: 5 });
    expect(columns[3]).toBe(1);
    expect([...columns].filter((level) => level > 0)).toHaveLength(1);
  });

  it('draws nothing for a dropped clip, or past the end', () => {
    const clips = [clip({ sourceOut: 4_000_000, enabled: false })];
    const audio = new Map([['src', tone(() => -10)]]);
    const columns = waveColumns({ clips, audio, fromUs: 0, usPerColumn: 1_000_000, columns: 6 });
    expect([...columns]).toEqual([0, 0, 0, 0, 0, 0]);

    const kept = waveColumns({
      clips: [clip({ sourceOut: 4_000_000 })],
      audio,
      fromUs: 0,
      usPerColumn: 1_000_000,
      columns: 6,
    });
    // Four seconds of clip, then nothing — the lane ends where the edit does.
    expect([...kept].map((level) => level > 0)).toEqual([true, true, true, true, false, false]);
  });

  it('draws nothing for a source whose audio could not be read', () => {
    const columns = waveColumns({
      clips: [clip()],
      audio: new Map(),
      fromUs: 0,
      usPerColumn: 1_000_000,
      columns: 4,
    });
    expect([...columns]).toEqual([0, 0, 0, 0]);
  });
});

describe('finding the clip under a moment', () => {
  const clips = [
    clip({ start: 0, sourceIn: 0, sourceOut: 2_000_000 }),
    clip({ start: 2_000_000, sourceIn: 5_000_000, sourceOut: 11_000_000, speed: 2 }),
  ];

  it('accounts for speed when working out where a clip ends', () => {
    // Six seconds of recording at 2x is three seconds of timeline, so this clip runs from
    // output 2s to output 5s — not to 8s.
    expect(clipAt(clips, 4_900_000)).toBe(clips[1]);
    expect(clipAt(clips, 5_100_000)).toBe(null);
  });

  it('finds the boundaries exactly', () => {
    expect(clipAt(clips, 0)).toBe(clips[0]);
    expect(clipAt(clips, 1_999_999)).toBe(clips[0]);
    expect(clipAt(clips, 2_000_000)).toBe(clips[1]);
  });
});
