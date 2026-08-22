import { SILENCE_DB } from '@evocut/signals';

/**
 * The audio, drawn under the picture.
 *
 * ## Where the data comes from
 *
 * Nowhere new. The signals pass already decodes every source's audio and reduces it to an
 * RMS level every 10ms — that is how it finds the hits and the dead air — and caches the
 * result per source. This reads the same array.
 *
 * That hop used to be 50ms, which is ample for finding hits and far too coarse for drawing
 * them: at the zoom the timeline now reaches, one hop is sixty pixels wide and the lane
 * reads as a row of blocks. Five times finer costs five times the numbers — a 27-minute
 * recording is about 163,000 of them — and nothing downstream noticed, because every
 * threshold in the analysis is stated in milliseconds rather than in hops.
 *
 * ## Level, not amplitude
 *
 * A literal waveform plots sample amplitude, and on real footage that is close to useless
 * on a phone: a take whose peak is −22 dBFS and whose median is −77 has an amplitude ratio
 * of about three hundred to one between its loud and ordinary moments, so the ordinary
 * moments — where all the cuts are — draw as a flat line. What is wanted is where the sound
 * *is*, at a glance, and that is a level envelope in decibels.
 *
 * ## Stretched to fit the recording it is drawing
 *
 * And scaled against this recording rather than against full scale, or against a fixed
 * window below its peak. See `displayFloor`: the first version used a flat 48 dB window,
 * which on the take above put the entire body of the recording below the floor and drew it
 * as blocks separated by nothing.
 *
 * ## Columns, not curves
 *
 * One value per pixel column, each the *loudest* level within the span of time that column
 * covers. Peak-per-column rather than average, because at a zoom where one column is a
 * second of audio, averaging turns every transient into the mush around it — and a
 * transient is exactly what you are looking for when you are placing a cut.
 */
export interface WaveSource {
  /** Spacing between levels, in microseconds. */
  hopUs: number;
  /** dBFS per hop. */
  loudness: number[];
  /** Loudest hop in the source, which the display is scaled against. */
  peakDb: number;
  /** The level this recording usually sits at, which sets where the floor goes. */
  medianDb: number;
}

/** What a column needs to know about the clip under it. */
export interface WaveClip {
  sourceId: string;
  /** Where the clip starts on the output timeline. */
  start: number;
  sourceIn: number;
  sourceOut: number;
  speed: number;
  enabled: boolean;
}

/**
 * Where the typical level of a recording should sit in the lane.
 *
 * The display is stretched so that the median lands here and the peak lands at the top.
 * A quarter height for "ordinary" leaves three quarters of the lane for the things that
 * stand out, which is what the lane is read for.
 */
const MEDIAN_AT = 0.25;

/** Bounds on how far the display may be stretched, in dB. */
const MIN_RANGE_DB = 36;
const MAX_RANGE_DB = 84;

/**
 * The level that draws as nothing, chosen from this recording rather than fixed.
 *
 * A flat window below the peak — the first version used 48 dB — assumes recordings have a
 * typical dynamic range. Real footage does not. A 27-minute take peaking at −22 dBFS with a
 * median of −77 has 55 dB between "ordinary" and "loud", so a 48 dB window puts the entire
 * body of the recording *below the floor*: every quiet stretch drew as nothing and every
 * column containing a transient drew full height. Blocks and gaps, with no shape between
 * them.
 *
 * Stretching the display instead is what the user asked for in so many words — "visualise
 * the audio as if it were scaled up heavily, but the audio plays as if it were normal" —
 * and it costs nothing, because this is a drawing decision that touches no sample.
 */
export function displayFloor(peakDb: number, medianDb: number): number {
  const wanted = (medianDb - MEDIAN_AT * peakDb) / (1 - MEDIAN_AT);
  const bounded = Math.min(Math.max(wanted, peakDb - MAX_RANGE_DB), peakDb - MIN_RANGE_DB);
  return Math.max(SILENCE_DB, bounded);
}

/** Level 0..1 for the loudest hop between two source times. Zero where there is nothing. */
export function levelBetween(audio: WaveSource, fromUs: number, toUs: number): number {
  const { hopUs, loudness } = audio;
  if (hopUs <= 0 || loudness.length === 0) return 0;

  const first = Math.max(0, Math.floor(Math.min(fromUs, toUs) / hopUs));
  /*
    Half-open, and it matters. Flooring both ends made the last hop of one column the first
    hop of the next, so a single transient drew as two columns — at a fine zoom, a hit
    smeared a frame wide in the direction of travel, which is precisely the error a
    waveform exists to prevent you making.

    Never narrower than one hop, though: zoomed all the way in a column is thinner than
    50ms, and an empty range would draw gaps through a continuous sound.
  */
  const end = Math.max(first, Math.ceil(Math.max(fromUs, toUs) / hopUs) - 1);
  const last = Math.min(loudness.length - 1, end);
  if (first >= loudness.length) return 0;

  let loudest = SILENCE_DB;
  for (let index = first; index <= last; index += 1) {
    const db = loudness[index]!;
    if (db > loudest) loudest = db;
  }
  return scaleDb(loudest, audio.peakDb, audio.medianDb);
}

/** dBFS to 0..1, stretched between this recording's own floor and its peak. */
export function scaleDb(db: number, peakDb: number, medianDb: number): number {
  const floor = displayFloor(peakDb, medianDb);
  if (db <= floor) return 0;
  return Math.min(1, (db - floor) / Math.max(1, peakDb - floor));
}

/** The clip covering an output time, or null in a gap or past the end. */
export function clipAt(clips: WaveClip[], outputUs: number): WaveClip | null {
  for (const clip of clips) {
    if (outputUs < clip.start) return null;
    if (outputUs < clip.start + outputLengthOf(clip)) return clip;
  }
  return null;
}

export interface WaveRequest {
  clips: WaveClip[];
  /** Level envelopes by source id. A source with no readable audio is simply absent. */
  audio: Map<string, WaveSource>;
  /** Output time at the left edge of the first column. */
  fromUs: number;
  /** How much output time one column covers. */
  usPerColumn: number;
  columns: number;
}

/**
 * One level per column, left to right.
 *
 * Output time in, source time out: a clip played at 2x covers twice as much of the
 * recording per column, and its audio has to compress to match — which is what the export
 * will do to it, so the drawing and the file agree.
 */
export function waveColumns({ clips, audio, fromUs, usPerColumn, columns }: WaveRequest): Float32Array {
  return columnsOver({ clips, fromUs, usPerColumn, columns }, (sourceId, from, to) => {
    const source = audio.get(sourceId);
    return source ? levelBetween(source, from, to) : 0;
  });
}

/**
 * Output time in, source time out, one column at a time.
 *
 * A cursor rather than a search. Columns run left to right, so the clip under one is never
 * before the clip under the last — and `clipAt` starting from the beginning every time made
 * this O(columns x clips), which on a fifty-clip edit repainted every frame is forty
 * thousand iterations a frame for a picture four hundred pixels wide.
 *
 * A clip played at 2x covers twice as much of the recording per column, and whatever is
 * drawn for it has to compress to match — which is what the export will do to it, so the
 * drawing and the file agree.
 */
function columnsOver(
  { clips, fromUs, usPerColumn, columns }: Omit<WaveRequest, 'audio'>,
  sample: (sourceId: string, fromSourceUs: number, toSourceUs: number) => number,
): Float32Array {
  const out = new Float32Array(Math.max(0, columns));
  if (usPerColumn <= 0) return out;

  let index = 0;
  for (let column = 0; column < out.length; column += 1) {
    const at = fromUs + column * usPerColumn;
    while (index < clips.length && at >= clips[index]!.start + outputLengthOf(clips[index]!)) {
      index += 1;
    }
    const clip = clips[index];
    if (!clip || !clip.enabled || at < clip.start) continue;

    const into = (at - clip.start) * clip.speed;
    const from = clip.sourceIn + into;
    const to = Math.min(clip.sourceOut, from + usPerColumn * clip.speed);
    out[column] = sample(clip.sourceId, from, to);
  }
  return out;
}

/** How long a clip runs on the output timeline. */
function outputLengthOf(clip: WaveClip): number {
  return Math.round((clip.sourceOut - clip.sourceIn) / clip.speed);
}
