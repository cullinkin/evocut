import { clipEnd, formatTimecode, type Clip, type Timeline } from '@evocut/edl';
import type { Onset, Region, SourceSignals } from './types.js';

/**
 * Signals, rewritten in the clock the model has to answer in.
 *
 * The measurements are in source time, because they belong to the recording. The model
 * emits ops in **output** time, against clip ids. A summary that made it do that conversion
 * itself would be handing it arithmetic to get wrong on top of the judgement we actually
 * want — so every number here is already mapped through the clip that contains it, and
 * anything falling in footage the coarse pass cut away simply is not mentioned.
 *
 * Both a timecode and the microsecond value are given for every time. The timecode is for
 * reasoning about; the microseconds are what goes in the op.
 */

export interface SignalSummaryOptions {
  /** Strongest N transients per clip. Beyond a handful it is a wall, not a signal. */
  maxOnsetsPerClip?: number;
  /** Include clips the coarse pass dropped. Off: they are not up for discussion. */
  includeDisabled?: boolean;
}

/**
 * One clip's signals, already on the output timeline.
 *
 * The structured form of what `describeSignals` renders as text. Both the prompt and the
 * local planner read from this, so a model and the heuristic stand-in are looking at
 * exactly the same measurements — and the source-to-output mapping, which is the part
 * with arithmetic in it, exists once.
 */
export interface ClipSignals {
  clipId: string;
  /** Quiet spans, clipped to what survived the coarse pass. */
  quiet: Region[];
  /** Transients inside this clip, strongest first. */
  hits: Onset[];
  /** Stretches where the picture barely changes. */
  still: Region[];
  /** dBFS within this clip. Null when the source has no audio. */
  peakDb: number | null;
  typicalDb: number | null;
  /** The whole recording's typical level, for comparison. */
  sourceMedianDb: number | null;
}

export function signalsForClip(clip: Clip, source: SourceSignals): ClipSignals {
  const { audio, motion } = source;
  const window = audio
    ? audio.loudness.slice(Math.floor(clip.sourceIn / audio.hopUs), Math.ceil(clip.sourceOut / audio.hopUs))
    : [];

  return {
    clipId: clip.id,
    quiet: audio ? mapRegions(audio.quiet, clip) : [],
    hits: audio ? mapOnsets(audio.onsets, clip) : [],
    still: motion ? mapRegions(motion.still, clip) : [],
    peakDb: window.length > 0 ? window.reduce((best, value) => Math.max(best, value), -Infinity) : null,
    typicalDb: window.length > 0 ? percentile(window, 0.5) : null,
    sourceMedianDb: audio ? audio.medianDb : null,
  };
}

const LEGEND = [
  'Signals measured from the footage. All times are on the OUTPUT timeline, so they can be',
  'used in ops directly. Levels are dBFS and only comparable within one recording.',
  '',
  '  level  peak and typical loudness of this clip.',
  '  quiet  runs well below this recording\'s own typical level: pauses, dead air, a stall.',
  '  hits   sudden rises in level — an impact, a landing, a hard consonant. The number in',
  '         brackets is strength from 0 to 1, relative to the biggest hit in the recording.',
  '         These are level transients only; a change of tone at a steady volume is invisible.',
  '  still  stretches where the picture barely changes. A locked-off shot, a held frame.',
  '',
  'Absence of a line means the measurement found nothing, not that nothing is there.',
].join('\n');

export function describeSignals(
  timeline: Timeline,
  signals: Map<string, SourceSignals>,
  options: SignalSummaryOptions = {},
): string {
  const maxOnsets = options.maxOnsetsPerClip ?? 6;
  const lines: string[] = [];

  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      if (!clip.enabled && !options.includeDisabled) continue;
      const source = signals.get(clip.sourceId);
      if (!source) continue;

      const parts = describeClipSignals(clip, source, maxOnsets);
      if (parts.length === 0) continue;

      lines.push(
        `  ${clip.id}  ${formatTimecode(clip.start)}–${formatTimecode(clipEnd(clip))}`,
        ...parts.map((part) => `      ${part}`),
      );
    }
  }

  if (lines.length === 0) return '';
  return [LEGEND, '', 'Per clip:', ...lines].join('\n');
}

function describeClipSignals(clip: Clip, source: SourceSignals, maxOnsets: number): string[] {
  const measured = signalsForClip(clip, source);
  const parts: string[] = [];

  if (measured.peakDb !== null && measured.typicalDb !== null) {
    const relative =
      measured.sourceMedianDb !== null && Math.abs(measured.typicalDb - measured.sourceMedianDb) >= 3
        ? // Only worth saying when it differs from the recording as a whole — that is the
          // comparison a "balance the clips" note would be based on.
          ` (${measured.typicalDb > measured.sourceMedianDb ? 'louder' : 'quieter'} than the rest of this take)`
        : '';
    parts.push(
      `level  peak ${measured.peakDb.toFixed(0)}dB / typical ${measured.typicalDb.toFixed(0)}dB${relative}`,
    );
  }

  if (measured.quiet.length > 0) parts.push(`quiet  ${measured.quiet.map(formatRegion).join(' · ')}`);

  const hits = measured.hits.slice(0, maxOnsets).sort((a, b) => a.t - b.t);
  if (hits.length > 0) {
    parts.push(
      `hits   ${hits
        .map((hit) => `${formatTimecode(hit.t)} (${hit.t}us, ${hit.strength.toFixed(2)})`)
        .join(' · ')}`,
    );
  }

  if (measured.still.length > 0) parts.push(`still  ${measured.still.map(formatRegion).join(' · ')}`);

  return parts;
}

/** Source regions clipped to a clip's used range and moved onto the output timeline. */
function mapRegions(regions: Region[], clip: Clip): Region[] {
  const out: Region[] = [];
  for (const region of regions) {
    const start = Math.max(region.start, clip.sourceIn);
    const end = Math.min(region.end, clip.sourceOut);
    // A pause that the coarse pass already cut in half is reported at the length that
    // survives, not the length it had in the raw take.
    if (end - start < 200_000) continue;
    out.push({ start: toOutput(clip, start), end: toOutput(clip, end) });
  }
  return out;
}

/** Transients inside the clip, on the output clock, strongest first. */
function mapOnsets(onsets: Onset[], clip: Clip): Onset[] {
  return onsets
    .filter((onset) => onset.t >= clip.sourceIn && onset.t < clip.sourceOut)
    .map((onset) => ({ t: toOutput(clip, onset.t), strength: onset.strength }))
    .sort((a, b) => b.strength - a.strength);
}

function toOutput(clip: Clip, sourceTime: number): number {
  return clip.start + Math.round((sourceTime - clip.sourceIn) / clip.speed);
}

function formatRegion(region: Region): string {
  return `${formatTimecode(region.start)}–${formatTimecode(region.end)} (${region.start}–${region.end}us)`;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}
