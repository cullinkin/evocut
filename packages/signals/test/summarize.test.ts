import { describe, expect, it } from 'vitest';
import {
  applyOps,
  createClip,
  createTimeline,
  createTrack,
  makeIdFactory,
  secondsToMicros as S,
} from '@evocut/edl';
import { describeSignals } from '../src/summarize.js';
import { SIGNALS_VERSION, type SourceSignals } from '../src/types.js';

function deps() {
  return { newId: makeIdFactory('s') };
}

/** Two clips from one take: source 2–10s, then source 18–30s. */
function timeline() {
  const d = deps();
  return createTimeline(
    {
      tracks: [
        createTrack(
          {
            kind: 'video',
            clips: [
              createClip({ sourceId: 'src_a', sourceIn: S(2), sourceOut: S(10) }, d),
              createClip({ sourceId: 'src_a', sourceIn: S(18), sourceOut: S(30) }, d),
            ],
          },
          d,
        ),
      ],
    },
    d,
  );
}

function signals(over: Partial<SourceSignals['audio'] & object> = {}): Map<string, SourceSignals> {
  return new Map([
    [
      'src_a',
      {
        version: SIGNALS_VERSION,
        sourceId: 'src_a',
        durationUs: S(40),
        computedAt: '2026-01-01T00:00:00.000Z',
        audio: {
          hopUs: 50_000,
          loudness: Array.from({ length: 800 }, () => -20),
          peakDb: -6,
          medianDb: -20,
          onsets: [
            { t: S(3), strength: 1 }, // inside the first clip
            { t: S(14), strength: 0.9 }, // in footage the coarse pass cut away
            { t: S(20), strength: 0.5 }, // inside the second clip
          ],
          quiet: [{ start: S(4), end: S(6) }],
          ...over,
        },
        motion: {
          hopUs: S(1),
          motion: [],
          still: [{ start: S(18), end: S(24) }],
        },
      },
    ],
  ]);
}

describe('describeSignals', () => {
  it('reports every time on the output timeline, not the source timeline', () => {
    const text = describeSignals(timeline(), signals());

    // The hit at source 3s is one second into the first clip, which starts at output 0.
    expect(text).toContain('00:00:01.000 (1000000us, 1.00)');
    // The hit at source 20s is two seconds into a clip that starts at output 8s.
    expect(text).toContain('00:00:10.000 (10000000us, 0.50)');
  });

  it('says nothing about footage the coarse pass cut away', () => {
    // The 0.9 hit sits at source 14s, in the gap between the two clips. Mentioning it
    // would invite the model to place an emphasis on a frame that does not exist.
    expect(describeSignals(timeline(), signals())).not.toContain('0.90');
  });

  it('follows a speed change, because the output clock does', () => {
    const tl = timeline();
    const clipId = tl.tracks[0]!.clips[0]!.id;
    const fast = applyOps(tl, [{ op: 'setSpeed', clipId, speed: 2 }], deps()).timeline;

    // Source 3s is one second past the clip's in point, which at 2x is half a second of
    // output. Reporting the source offset here would put every emphasis in the wrong place.
    expect(describeSignals(fast, signals())).toContain('(500000us, 1.00)');
  });

  it('clips a region to the part of it that survived', () => {
    const tl = timeline();
    const clipId = tl.tracks[0]!.clips[1]!.id;
    // The still stretch runs source 18–24s; trimming the clip's head to 21s leaves three
    // seconds of it, and that is what should be reported.
    const trimmed = applyOps(tl, [{ op: 'trim', clipId, sourceIn: S(21) }], deps()).timeline;
    const text = describeSignals(trimmed, signals());
    expect(text).toContain('still');
    expect(text).toMatch(/still\s+00:00:08\.000–00:00:11\.000/);
  });

  it('leaves out a clip whose source was never analysed', () => {
    expect(describeSignals(timeline(), new Map())).toBe('');
  });

  it('says which clips are louder or quieter than the take they came from', () => {
    const quiet = signals();
    // Second clip's window: hops 360 onward. Drop those well below the take's median.
    const audio = quiet.get('src_a')!.audio!;
    for (let i = 360; i < audio.loudness.length; i += 1) audio.loudness[i] = -34;

    const text = describeSignals(timeline(), quiet);
    expect(text).toContain('quieter than the rest of this take');
  });

  it('keeps only the strongest handful of hits per clip', () => {
    const many = signals({
      onsets: Array.from({ length: 30 }, (_, i) => ({ t: S(2) + i * 200_000, strength: i / 30 })),
    });
    // Matched below the legend, which has its own line explaining what "hits" means.
    const perClip = describeSignals(timeline(), many, { maxOnsetsPerClip: 4 }).split('Per clip:')[1] ?? '';
    const hits = perClip.match(/^\s+hits\s+(.*)$/m)?.[1] ?? '';
    expect(hits.split('·')).toHaveLength(4);
    // Strongest kept, but listed in the order they happen — an op list is chronological.
    const times = [...hits.matchAll(/\((\d+)us/g)].map((m) => Number(m[1]));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});
