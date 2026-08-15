import { describe, expect, it } from 'vitest';
import { analyzeAudio, detectOnsets, findRuns, rmsEnvelope, toMono, strongest } from '../src/audio.js';
import { SILENCE_DB } from '../src/types.js';

const RATE = 8000;

/**
 * Signals are tested against audio built to contain a known answer.
 *
 * There is no fixture recording, because a fixture has no ground truth — you can only
 * check that the numbers have not changed, which passes just as happily when they were
 * wrong to begin with. Constructed audio says where the pause is, so the test can ask
 * whether the analysis found *that* one.
 */
function silence(seconds: number): Float32Array {
  return new Float32Array(Math.round(RATE * seconds));
}

function tone(seconds: number, amplitude = 0.3): Float32Array {
  const out = new Float32Array(Math.round(RATE * seconds));
  for (let i = 0; i < out.length; i += 1) out[i] = Math.sin((i / RATE) * 2 * Math.PI * 220) * amplitude;
  return out;
}

function join(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe('rmsEnvelope', () => {
  it('measures a full-scale square wave at 0dB and silence at the floor', () => {
    const loud = new Float32Array(RATE).fill(1);
    expect(rmsEnvelope(loud, RATE)[0]).toBeCloseTo(0, 3);
    expect(rmsEnvelope(silence(1), RATE)[0]).toBe(SILENCE_DB);
  });

  it('produces one measurement per hop', () => {
    expect(rmsEnvelope(tone(2), RATE / 10)).toHaveLength(20);
  });
});

describe('analyzeAudio', () => {
  it('finds the pause that was put there, and not the ones that were not', () => {
    // Two seconds of tone, a second and a half of nothing, two more seconds of tone.
    const signals = analyzeAudio(join(tone(2), silence(1.5), tone(2)), RATE);

    expect(signals.quiet).toHaveLength(1);
    const [gap] = signals.quiet;
    expect(gap!.start / 1e6).toBeCloseTo(2, 1);
    expect(gap!.end / 1e6).toBeCloseTo(3.5, 1);
  });

  it('ignores a gap too short to be dead air', () => {
    // 200ms is a breath between words, not a pause worth cutting.
    expect(analyzeAudio(join(tone(1), silence(0.2), tone(1)), RATE).quiet).toEqual([]);
  });

  it('reports the peak and the typical level separately', () => {
    const signals = analyzeAudio(join(tone(3, 0.1), tone(0.3, 0.9), tone(3, 0.1)), RATE);
    expect(signals.peakDb).toBeGreaterThan(signals.medianDb + 10);
    // A brief shout should not drag the median with it — that is what the median is for.
    expect(signals.medianDb).toBeLessThan(-15);
  });

  it('hears a hit where the level jumps', () => {
    const signals = analyzeAudio(join(tone(2, 0.02), tone(0.4, 0.9), tone(2, 0.02)), RATE);
    expect(signals.onsets.length).toBeGreaterThanOrEqual(1);

    const loudest = signals.onsets.reduce((best, o) => (o.strength > best.strength ? o : best));
    expect(loudest.t / 1e6).toBeCloseTo(2, 1);
    expect(loudest.strength).toBeCloseTo(1, 2);
  });

  it('does not invent hits in steady sound', () => {
    expect(analyzeAudio(tone(6), RATE).onsets).toEqual([]);
  });

  it('does not turn a slow fade-in into a run of hits', () => {
    // A crescendo rises every hop. Thresholding on level alone would call each one an
    // onset and hand the model forty "hits" in a row.
    const ramp = new Float32Array(RATE * 5);
    for (let i = 0; i < ramp.length; i += 1) {
      ramp[i] = Math.sin((i / RATE) * 2 * Math.PI * 220) * (i / ramp.length) * 0.8;
    }
    expect(analyzeAudio(ramp, RATE).onsets.length).toBeLessThanOrEqual(2);
  });

  it('survives audio too short to analyse', () => {
    const signals = analyzeAudio(new Float32Array(16), RATE);
    expect(signals.onsets).toEqual([]);
    expect(signals.quiet).toEqual([]);
  });
});

describe('detectOnsets', () => {
  it('merges transients closer together than the minimum gap', () => {
    // Three adjacent spikes in the envelope: one event, reported once.
    const envelope = [-60, -60, -60, -20, -22, -19, -60, -60, -60, -60];
    expect(detectOnsets(envelope, 50_000, 300)).toHaveLength(1);
  });

  it('keeps transients that are genuinely separate', () => {
    const quiet = Array(8).fill(-60);
    const envelope = [...quiet, -20, ...quiet, -20, ...quiet];
    expect(detectOnsets(envelope, 50_000, 150).length).toBe(2);
  });
});

describe('findRuns', () => {
  it('measures a run that reaches the end of the values', () => {
    const runs = findRuns([1, 1, 0, 0, 0, 0], 100_000, (v) => v === 0, 300);
    expect(runs).toEqual([{ start: 200_000, end: 600_000 }]);
  });
});

describe('toMono', () => {
  it('averages the channels', () => {
    const mono = toMono([new Float32Array([1, 0]), new Float32Array([0, 1])]);
    expect([...mono]).toEqual([0.5, 0.5]);
  });

  it('passes a mono buffer straight through', () => {
    const single = new Float32Array([0.25]);
    expect(toMono([single])).toBe(single);
  });
});

describe('strongest', () => {
  const at = (t: number, strength: number) => ({ t: t * 1_000_000, strength });

  it('leaves a modest list alone', () => {
    const found = [at(1, 0.2), at(2, 0.9), at(3, 0.4)];
    expect(strongest(found, 5, 12)).toEqual(found);
  });

  /**
   * The measurement that prompted this: 3,505 transients over a 27-minute recording — one
   * every half second, which is every syllable of continuous speech rather than anything a
   * person would call a hit. Peak-picking is doing its job; "hit" is the word that was
   * wrong, and notability is inherently rate-limited.
   */
  it('thins a flood to a rate, keeping the sharpest', () => {
    const flood = Array.from({ length: 600 }, (_, i) => at(i, (i % 10) / 10));
    const kept = strongest(flood, 10, 12);

    expect(kept).toHaveLength(120);
    expect(Math.min(...kept.map((onset) => onset.strength))).toBeGreaterThan(0.5);
    // Still in time order: the caller reads these as a timeline, not as a ranking.
    expect(kept.map((onset) => onset.t)).toEqual([...kept.map((onset) => onset.t)].sort((a, b) => a - b));
  });

  it('scales with length rather than truncating the tail of a long take', () => {
    const flood = Array.from({ length: 600 }, (_, i) => at(i, (i % 10) / 10));
    // Thinning must not become "the first N": the last minute deserves the same treatment
    // as the first, which a count-based cap silently denies it.
    const kept = strongest(flood, 10, 12);
    expect(kept.at(-1)!.t).toBeGreaterThan(590_000_000 * 0.9);
  });

  it('never leaves a short take with nothing', () => {
    const few = Array.from({ length: 9 }, (_, i) => at(i, (i + 1) / 10));
    expect(strongest(few, 0.1, 12).length).toBe(4);
  });
});
