import { SILENCE_DB } from '@evocut/signals';

/**
 * The audio, drawn under the picture.
 *
 * ## Where the data comes from
 *
 * Nowhere new. The signals pass already decodes every source's audio and reduces it to an
 * RMS level every 50ms — that is how it finds the hits and the dead air — and caches the
 * result per source. This reads the same array. A 27-minute recording is about 33,000
 * numbers, which is nothing to hold and nothing to draw from.
 *
 * ## Level, not amplitude
 *
 * A literal waveform plots sample amplitude, and on real footage that is close to useless
 * on a phone: a take whose peak is −22 dBFS and whose median is −77 has an amplitude ratio
 * of about three hundred to one between its loud and ordinary moments, so the ordinary
 * moments — where all the cuts are — draw as a flat line. What is wanted is where the
 * sound *is*, at a glance, and that is a level envelope: decibels, floored a fixed distance
 * below this recording's own peak, mapped to the height of the lane.
 *
 * Relative to the recording's peak rather than to full scale, for the same reason the quiet
 * detector works that way: a take shot at arm's length in a room and one shouted into wind
 * have nothing in common on an absolute scale, and both have obvious shape.
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
 * How far below the peak counts as silence on the display.
 *
 * 48 dB is the range a small screen can show without either clipping everything together
 * or flattening the body of the recording into the floor. Wider and ordinary speech becomes
 * a hairline; narrower and every moderate sound pins to the top.
 */
export const DISPLAY_RANGE_DB = 48;

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
  return scaleDb(loudest, audio.peakDb);
}

/** dBFS to 0..1, relative to this recording's peak. */
export function scaleDb(db: number, peakDb: number): number {
  const floor = Math.max(SILENCE_DB, peakDb - DISPLAY_RANGE_DB);
  if (db <= floor) return 0;
  return Math.min(1, (db - floor) / Math.max(1, peakDb - floor));
}

/** The clip covering an output time, or null in a gap or past the end. */
export function clipAt(clips: WaveClip[], outputUs: number): WaveClip | null {
  for (const clip of clips) {
    if (outputUs < clip.start) return null;
    const length = Math.round((clip.sourceOut - clip.sourceIn) / clip.speed);
    if (outputUs < clip.start + length) return clip;
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
  const out = new Float32Array(Math.max(0, columns));
  if (usPerColumn <= 0) return out;

  for (let column = 0; column < out.length; column += 1) {
    const at = fromUs + column * usPerColumn;
    const clip = clipAt(clips, at);
    if (!clip || !clip.enabled) continue;

    const source = audio.get(clip.sourceId);
    if (!source) continue;

    const into = (at - clip.start) * clip.speed;
    const from = clip.sourceIn + into;
    const to = Math.min(clip.sourceOut, from + usPerColumn * clip.speed);
    out[column] = levelBetween(source, from, to);
  }
  return out;
}
