import { SILENCE_DB, type AudioSignals, type Onset, type Region } from './types.js';

/**
 * Loudness, transients, and dead air, from raw samples.
 *
 * ## The measurements
 *
 * **Loudness** is plain RMS per hop, in dBFS. Not LUFS: loudness units want a K-weighting
 * filter and a gating algorithm, and what the refinement pass actually needs to know is
 * "is this bit louder or quieter than the rest of this recording", which is a comparison
 * within one source where the weighting cancels out.
 *
 * **Onsets** come from the positive change in that envelope, thresholded against a rolling
 * median of itself. This finds *level* transients — an impact, a clap, a hard consonant,
 * the moment something lands. It does not find timbral changes at constant level, which
 * would need a spectral flux and therefore an FFT; that is a real limit and worth knowing
 * before trusting the word "hit" too far.
 *
 * **Quiet** is the inverse and the most immediately useful of the three: a run of hops
 * below a floor, long enough that a person would notice the pause.
 */

export interface AudioAnalysisOptions {
  /** Spacing between measurements. 50ms resolves a transient without producing a novel. */
  hopMs?: number;
  /** Below this, relative to the source's own median, counts as dead air. */
  quietBelowDb?: number;
  /** Shorter gaps than this are breathing, not dead air. */
  minQuietMs?: number;
  /** Two transients closer than this are one transient. */
  minOnsetGapMs?: number;
}

const DEFAULTS = {
  hopMs: 50,
  quietBelowDb: -18,
  minQuietMs: 600,
  minOnsetGapMs: 150,
} satisfies Required<AudioAnalysisOptions>;

export function analyzeAudio(
  samples: Float32Array,
  sampleRate: number,
  options: AudioAnalysisOptions = {},
): AudioSignals {
  const settings = { ...DEFAULTS, ...options };
  const hop = Math.max(1, Math.round((sampleRate * settings.hopMs) / 1000));
  const hopUs = Math.round((hop / sampleRate) * 1_000_000);

  const loudness = rmsEnvelope(samples, hop);
  const peakDb = maxOf(loudness, SILENCE_DB);
  const medianDb = median(loudness);

  return {
    hopUs,
    loudness,
    peakDb,
    medianDb,
    onsets: detectOnsets(loudness, hopUs, settings.minOnsetGapMs),
    // Measured against this recording's own median rather than an absolute level. A take
    // shot at arm's length in a quiet room and one shouted into the wind have nothing in
    // common on an absolute scale, and both have obvious pauses.
    quiet: findRuns(
      loudness,
      hopUs,
      (db) => db < Math.max(medianDb + settings.quietBelowDb, SILENCE_DB + 1),
      settings.minQuietMs,
    ),
  };
}

/** Root mean square per hop, in dBFS. One value per hop, no overlap. */
export function rmsEnvelope(samples: Float32Array, hop: number): number[] {
  const out: number[] = [];
  for (let at = 0; at < samples.length; at += hop) {
    const end = Math.min(at + hop, samples.length);
    let sum = 0;
    for (let i = at; i < end; i += 1) sum += samples[i]! * samples[i]!;
    const rms = Math.sqrt(sum / Math.max(1, end - at));
    out.push(rms > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(rms)) : SILENCE_DB);
  }
  return out;
}

/**
 * Peaks in the rise of the loudness envelope.
 *
 * The threshold is a rolling median of the rise rather than a constant, because a constant
 * finds every syllable in a loud passage and nothing at all in a quiet one. Comparing each
 * rise against its own neighbourhood asks "was this sudden *here*", which is the question.
 */
export function detectOnsets(loudness: number[], hopUs: number, minGapMs: number): Onset[] {
  if (loudness.length < 3) return [];

  const rise = loudness.map((db, index) => (index === 0 ? 0 : Math.max(0, db - loudness[index - 1]!)));
  const windowHops = Math.max(3, Math.round(1_000_000 / hopUs)); // about a second either side
  const strongest = maxOf(rise, 0);
  if (strongest <= 0) return [];

  const found: Onset[] = [];
  const minGapHops = Math.max(1, Math.round((minGapMs * 1000) / hopUs));

  for (let index = 1; index < rise.length - 1; index += 1) {
    const value = rise[index]!;
    // A peak, not merely a threshold crossing: without this every hop of a long
    // crescendo qualifies, and the model gets forty "hits" in a row.
    if (value < rise[index - 1]! || value < rise[index + 1]!) continue;

    const local = median(rise.slice(Math.max(0, index - windowHops), index + windowHops));
    // 3dB over the neighbourhood's typical rise, and at least 3dB in absolute terms, so a
    // dead-silent passage does not make its own faint rustles into events.
    if (value < Math.max(local * 2 + 3, 3)) continue;

    const strength = Number((value / strongest).toFixed(3));
    const previous = found.at(-1);
    // Two transients a hair apart are one transient; keep whichever was sharper.
    if (previous && index * hopUs - previous.t < minGapHops * hopUs) {
      if (strength > previous.strength) {
        previous.t = index * hopUs;
        previous.strength = strength;
      }
      continue;
    }

    found.push({ t: index * hopUs, strength });
  }

  return found;
}

function maxOf(values: number[], fallback: number): number {
  let best = fallback;
  for (const value of values) if (value > best) best = value;
  return best;
}

/** Runs of consecutive hops satisfying a predicate, longer than a minimum. */
export function findRuns(
  values: number[],
  hopUs: number,
  matches: (value: number) => boolean,
  minMs: number,
): Region[] {
  const runs: Region[] = [];
  const minUs = minMs * 1000;
  let start: number | null = null;

  for (const [index, value] of values.entries()) {
    if (matches(value)) {
      start ??= index;
      continue;
    }
    if (start !== null) {
      pushRun(runs, start * hopUs, index * hopUs, minUs);
      start = null;
    }
  }
  if (start !== null) pushRun(runs, start * hopUs, values.length * hopUs, minUs);

  return runs;
}

function pushRun(runs: Region[], start: number, end: number, minUs: number): void {
  if (end - start >= minUs) runs.push({ start, end });
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/**
 * Fold a multi-channel buffer down to one channel of samples.
 *
 * Analysis has no use for stereo — nothing downstream asks which side a sound came from —
 * and a mono buffer is half the memory to hold while a phone is also holding the video.
 */
export function toMono(channels: Float32Array[]): Float32Array {
  const first = channels[0];
  if (!first) return new Float32Array(0);
  if (channels.length === 1) return first;

  const out = new Float32Array(first.length);
  for (const channel of channels) {
    for (let i = 0; i < out.length; i += 1) out[i]! += channel[i]! / channels.length;
  }
  return out;
}
