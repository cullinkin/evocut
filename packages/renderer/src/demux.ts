/**
 * Finding the audio in an MP4, without reading the MP4.
 *
 * ## Why this exists
 *
 * Everything else in this project decodes through the platform: a `<video>` element plays,
 * and we take the pictures it presents. Audio cannot work that way. `decodeAudioData` is
 * the only route from a container to samples, and it takes an `ArrayBuffer` — the whole
 * file, in memory, at once. A phone recording is minutes long and gigabytes large, and
 * `file.arrayBuffer()` on one of those does not return. It throws, or the tab dies.
 *
 * That is not a hypothetical. It is what silently disabled the entire signals pass on a
 * 5.2 GB recording: every source came back with no audio at all, the refinement pass was
 * asked to find the hits in footage it could not hear, and it correctly declined.
 *
 * So: read the index, not the file. In an MP4 the audio track's sample table is a few
 * hundred kilobytes inside `moov`, and it says exactly where every audio frame lives. With
 * that in hand the audio can be pulled out with `Blob.slice` — for a 27-minute recording,
 * about 26 MB of AAC out of 5.2 GB — and fed to `AudioDecoder` a chunk at a time. The
 * video data is never touched.
 *
 * ## What it handles, and what it does not
 *
 * Progressive MP4 and QuickTime, which is what phones write, `moov` at either end. AAC via
 * `esds` and Opus via `dOps`, because those are the two this project also *writes* — the
 * round trip through `Mp4Writer` is how the parser is tested.
 *
 * Not fragmented MP4 (`moof`), and not Matroska. Both return null, and every caller has a
 * fallback for null, because "this browser could not read the audio" has always been an
 * ordinary outcome here rather than an error.
 *
 * Edit lists are read only far enough to honour a codec's priming delay — a single-entry
 * `elst` with a positive `media_time`, which is how an iPhone marks AAC's encoder delay.
 * A genuine multi-segment edit list is ignored, which would put the audio out of step with
 * the picture; no phone writes one, and this says so rather than pretending otherwise.
 */

import type { Rational } from '@evocut/edl';

export interface AudioSampleRef {
  /** Byte offset of the frame within the file. */
  offset: number;
  size: number;
  /** Presentation time within the source, in microseconds. */
  timestampUs: number;
  durationUs: number;
}

export interface SourceAudioTrack {
  /** WebCodecs codec string, ready for `AudioDecoder.configure`. */
  codec: string;
  sampleRate: number;
  channels: number;
  /** Decoder configuration record, where the codec needs one. */
  description: Uint8Array | null;
  durationUs: number;
  /** Every audio frame, in presentation order. */
  samples: AudioSampleRef[];
  /** Total bytes of audio — a few tens of MB where the file is a few GB. */
  byteLength: number;
}

/** Read enough of `moov` to locate the audio. Null when there is none this can use. */
export async function readAudioTrack(file: Blob): Promise<SourceAudioTrack | null> {
  const moov = await findTopLevelBox(file, 'moov');
  if (!moov) return null;

  // The only large read in this module, and it is the index rather than the media: a few
  // hundred kilobytes for a recording whose `mdat` is gigabytes.
  const bytes = new Uint8Array(await file.slice(moov.start, moov.end).arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (const trak of childBoxes(view, 0, bytes.byteLength)) {
    if (trak.type !== 'trak') continue;
    const track = readSoundTrack(view, trak);
    if (track) return track;
  }
  return null;
}

/**
 * What the video track's `stts` says the frame rate is.
 *
 * A `<video>` element will not tell you this — it reports duration and dimensions and
 * nothing else — so until now every source was recorded at a nominal 30fps regardless of
 * what it actually was. That was harmless while cut points only ever lived in microseconds
 * and were snapped at render time. It stops being harmless the moment the ruler draws
 * *frames*: a tick labelled `15f` half a second in is a lie on a 60fps recording, and it is
 * a lie the user is aiming a cut at.
 *
 * Read from the same `moov` index the audio comes out of, so it costs a few hundred
 * kilobytes rather than a decode. The answer is a rational rather than a float because
 * containers are honest about 30000/1001 and rounding it to 29.97 puts a frame boundary
 * three milliseconds out by the end of a two-minute take.
 *
 * Null for anything this cannot read — WebM, fragmented MP4, a track with no sample table —
 * and every caller falls back to nominal, exactly as before.
 */
export interface VideoRate {
  frameRate: Rational;
  /**
   * True when the sample table holds meaningfully varied durations.
   *
   * Phones do this: a recording that dropped its rate in low light carries a `stts` full of
   * different deltas, and `frameRate` is then the most common one rather than the whole
   * truth. Worth passing on, because a frame ruler over VFR footage is approximate and the
   * EDL says so.
   */
  variable: boolean;
}

/** How much of the recording has to share one duration before it counts as constant. */
const CONSTANT_RATE_SHARE = 0.9;

export async function readVideoFrameRate(file: Blob): Promise<VideoRate | null> {
  const moov = await findTopLevelBox(file, 'moov');
  if (!moov) return null;

  const bytes = new Uint8Array(await file.slice(moov.start, moov.end).arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (const trak of childBoxes(view, 0, bytes.byteLength)) {
    if (trak.type !== 'trak') continue;
    const rate = readVideoTrackRate(view, trak);
    if (rate) return rate;
  }
  return null;
}

/** One line fit for a log row: what was found, or why nothing was. */
export function describeAudioTrack(track: SourceAudioTrack | null): string {
  if (!track) return 'no readable audio track';
  const seconds = (track.durationUs / 1_000_000).toFixed(1);
  const mb = (track.byteLength / 1_048_576).toFixed(1);
  return `${track.codec} ${track.channels}ch ${track.sampleRate}Hz, ${seconds}s, ${track.samples.length} frames, ${mb}MB`;
}

// --- The container -------------------------------------------------------------------

interface BoxRef {
  type: string;
  /** Payload bounds, header excluded. */
  start: number;
  end: number;
}

/**
 * Walk the file's top-level boxes to find one, reading sixteen bytes per box.
 *
 * `moov` can sit before or after `mdat` — recorders differ, and a device that writes it
 * last is the common case for anything recorded rather than transcoded. Either way this
 * costs one small read per box rather than a scan.
 */
async function findTopLevelBox(file: Blob, type: string): Promise<{ start: number; end: number } | null> {
  let at = 0;
  while (at + 8 <= file.size) {
    const header = new DataView(await file.slice(at, Math.min(at + 16, file.size)).arrayBuffer());
    if (header.byteLength < 8) return null;

    let size = header.getUint32(0);
    let headerSize = 8;
    if (size === 1) {
      if (header.byteLength < 16) return null;
      size = Number(header.getBigUint64(8));
      headerSize = 16;
    } else if (size === 0) {
      // "To the end of the file" — legal, and only ever the last box.
      size = file.size - at;
    }
    if (size < headerSize) return null;

    if (fourcc(header, 4) === type) return { start: at + headerSize, end: at + size };
    at += size;
  }
  return null;
}

function* childBoxes(view: DataView, from: number, to: number): Generator<BoxRef> {
  let at = from;
  while (at + 8 <= to) {
    let size = view.getUint32(at);
    const type = fourcc(view, at + 4);
    let headerSize = 8;
    if (size === 1) {
      if (at + 16 > to) return;
      size = Number(view.getBigUint64(at + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = to - at;
    }
    // A box that claims to run past its parent is a truncated or corrupt file. Stopping
    // returns whatever was already parsed, which is more useful than throwing.
    if (size < headerSize || at + size > to) return;

    yield { type, start: at + headerSize, end: at + size };
    at += size;
  }
}

function findBox(view: DataView, parent: BoxRef, type: string): BoxRef | null {
  for (const box of childBoxes(view, parent.start, parent.end)) {
    if (box.type === type) return box;
  }
  return null;
}

/** Follow a chain of single children, e.g. `mdia` → `minf` → `stbl`. */
function descend(view: DataView, parent: BoxRef, ...path: string[]): BoxRef | null {
  let box: BoxRef | null = parent;
  for (const step of path) {
    if (!box) return null;
    box = findBox(view, box, step);
  }
  return box;
}

function fourcc(view: DataView, at: number): string {
  return String.fromCharCode(
    view.getUint8(at),
    view.getUint8(at + 1),
    view.getUint8(at + 2),
    view.getUint8(at + 3),
  );
}

// --- The track -----------------------------------------------------------------------

function readSoundTrack(view: DataView, trak: BoxRef): SourceAudioTrack | null {
  const mdia = findBox(view, trak, 'mdia');
  if (!mdia) return null;

  const hdlr = findBox(view, mdia, 'hdlr');
  // version+flags, then four bytes of `pre_defined`, then the handler type.
  if (!hdlr || hdlr.end - hdlr.start < 12 || fourcc(view, hdlr.start + 8) !== 'soun') return null;

  const mdhd = findBox(view, mdia, 'mdhd');
  const stbl = descend(view, mdia, 'minf', 'stbl');
  if (!mdhd || !stbl) return null;

  const timescale = readMdhdTimescale(view, mdhd);
  if (!timescale) return null;

  const stsd = findBox(view, stbl, 'stsd');
  const format = stsd ? readSampleEntry(view, stsd) : null;
  if (!format) return null;

  const sizes = readSampleSizes(view, stbl);
  const deltas = readSampleDeltas(view, stbl, sizes.length);
  const offsets = readSampleOffsets(view, stbl, sizes);
  if (sizes.length === 0 || offsets.length !== sizes.length || deltas.length !== sizes.length) {
    return null;
  }

  // AAC's encoder delay: the file carries a few frames of priming that are not part of the
  // recording, and the edit list is where that is declared. Subtracting it here is what
  // keeps a trim at 4.000s meaning the same thing to us as it does to the phone.
  const priming = readPrimingDelay(view, trak);

  const samples: AudioSampleRef[] = [];
  let at = 0;
  let byteLength = 0;
  for (let index = 0; index < sizes.length; index += 1) {
    const start = at;
    at += deltas[index]!;
    byteLength += sizes[index]!;
    samples.push({
      offset: offsets[index]!,
      size: sizes[index]!,
      timestampUs: Math.round(((start - priming) * 1_000_000) / timescale),
      durationUs: Math.round((deltas[index]! * 1_000_000) / timescale),
    });
  }

  return {
    codec: format.codec,
    // The `stsd` rate is a 16.16 fixed-point field, so it cannot express 48000 for Opus in
    // some writers; the codec's own configuration wins wherever it disagrees.
    sampleRate: format.sampleRate || Math.round(timescale),
    channels: format.channels || 1,
    description: format.description,
    durationUs: Math.round(((at - priming) * 1_000_000) / timescale),
    samples,
    byteLength,
  };
}

function readVideoTrackRate(view: DataView, trak: BoxRef): VideoRate | null {
  const mdia = findBox(view, trak, 'mdia');
  if (!mdia) return null;

  const hdlr = findBox(view, mdia, 'hdlr');
  if (!hdlr || hdlr.end - hdlr.start < 12 || fourcc(view, hdlr.start + 8) !== 'vide') return null;

  const mdhd = findBox(view, mdia, 'mdhd');
  const stbl = descend(view, mdia, 'minf', 'stbl');
  if (!mdhd || !stbl) return null;

  const timescale = readMdhdTimescale(view, mdhd);
  if (!timescale) return null;

  const durations = sampleDurationHistogram(view, stbl);
  if (durations.frames === 0 || durations.commonest === 0) return null;

  const fps = timescale / durations.commonest;
  // A number outside this band is a misparse rather than a recording — a slideshow track, a
  // timecode track, or a `stts` we read wrong — and nominal is a better answer than nonsense.
  if (!Number.isFinite(fps) || fps < 1 || fps > 1000) return null;

  const divisor = gcd(timescale, durations.commonest);
  return {
    frameRate: { num: timescale / divisor, den: durations.commonest / divisor },
    variable: durations.share < CONSTANT_RATE_SHARE,
  };
}

/**
 * The most common sample duration, and how much of the track shares it.
 *
 * Read straight off `stts`'s run-length form rather than the expanded per-sample list: a
 * half-hour 4K recording has a hundred thousand frames and two or three runs.
 */
function sampleDurationHistogram(
  view: DataView,
  stbl: BoxRef,
): { commonest: number; frames: number; share: number } {
  const empty = { commonest: 0, frames: 0, share: 0 };
  const stts = findBox(view, stbl, 'stts');
  if (!stts) return empty;

  const runs = view.getUint32(stts.start + 4);
  const byDuration = new Map<number, number>();
  let frames = 0;
  for (let run = 0; run < runs; run += 1) {
    const at = stts.start + 8 + run * 8;
    if (at + 8 > stts.end) break;
    const count = view.getUint32(at);
    const delta = view.getUint32(at + 4);
    // A zero delta is a sample with no duration of its own — not a frame rate.
    if (delta === 0 || count === 0) continue;
    byDuration.set(delta, (byDuration.get(delta) ?? 0) + count);
    frames += count;
  }
  if (frames === 0) return empty;

  let commonest = 0;
  let best = 0;
  for (const [delta, count] of byDuration) {
    if (count > best) {
      best = count;
      commonest = delta;
    }
  }
  return { commonest, frames, share: best / frames };
}

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y !== 0) [x, y] = [y, x % y];
  return x || 1;
}

function readMdhdTimescale(view: DataView, mdhd: BoxRef): number {
  const version = view.getUint8(mdhd.start);
  const at = mdhd.start + 4 + (version === 1 ? 16 : 8);
  if (at + 4 > mdhd.end) return 0;
  return view.getUint32(at);
}

/**
 * The priming delay, from a single-entry edit list.
 *
 * A one-entry `elst` whose `media_time` is positive says "the presentation starts this far
 * into the media" — which for an audio track is the codec's own warm-up. Anything more
 * elaborate than that is a real edit, and honouring it properly would mean rewriting the
 * sample timeline; this leaves those alone rather than half-applying them.
 */
function readPrimingDelay(view: DataView, trak: BoxRef): number {
  const elst = descend(view, trak, 'edts', 'elst');
  if (!elst) return 0;

  const version = view.getUint8(elst.start);
  const count = view.getUint32(elst.start + 4);
  if (count !== 1) return 0;

  const at = elst.start + 8;
  const mediaTime = version === 1 ? Number(view.getBigInt64(at + 8)) : view.getInt32(at + 4);
  return mediaTime > 0 ? mediaTime : 0;
}

interface SampleFormat {
  codec: string;
  sampleRate: number;
  channels: number;
  description: Uint8Array | null;
}

/**
 * The first sample entry: which codec, and how to configure its decoder.
 *
 * The audio sample entry has three layouts. Version 0 is the MP4 one and what almost
 * everything writes; QuickTime's versions 1 and 2 pad it, and version 2 restates the rate
 * as a float and the channel count as a word. Reading the version rather than assuming it
 * is the difference between finding the codec box and finding sixteen bytes of padding.
 */
function readSampleEntry(view: DataView, stsd: BoxRef): SampleFormat | null {
  // version+flags, entry_count, then the entries as boxes.
  const entries: BoxRef[] = [...childBoxes(view, stsd.start + 8, stsd.end)];
  const entry = entries[0];
  if (!entry) return null;

  const version = view.getUint16(entry.start + 8);
  let channels = view.getUint16(entry.start + 16);
  let sampleRate = view.getUint32(entry.start + 24) / 65536;
  let configAt = entry.start + 28;

  if (version === 1) {
    configAt += 16;
  } else if (version === 2) {
    sampleRate = view.getFloat64(entry.start + 32);
    channels = view.getUint32(entry.start + 40);
    configAt += 36;
  }

  const config: BoxRef = { type: entry.type, start: configAt, end: entry.end };

  if (entry.type === 'mp4a') {
    const esds = findBox(view, config, 'esds');
    const asc = esds ? readDecoderSpecificInfo(view, esds) : null;
    return {
      codec: asc ? `mp4a.40.${aacObjectType(asc)}` : 'mp4a.40.2',
      sampleRate: Math.round(sampleRate),
      channels,
      description: asc,
    };
  }

  if (entry.type === 'Opus' || entry.type === 'opus') {
    const dOps = findBox(view, config, 'dOps');
    if (!dOps) return null;
    return {
      codec: 'opus',
      // Opus always decodes at 48kHz whatever the original rate in `dOps` says.
      sampleRate: 48_000,
      channels: view.getUint8(dOps.start + 1) || channels,
      description: opusHeadFrom(view, dOps),
    };
  }

  // Something real but unsupported — ALAC, AC-3, PCM. Named rather than swallowed, so the
  // log says which codec defeated it instead of "no audio".
  return { codec: entry.type.trim().toLowerCase(), sampleRate: Math.round(sampleRate), channels, description: null };
}

/**
 * Dig the AudioSpecificConfig out of `esds`.
 *
 * MPEG-4 descriptors are a tag/length tree with a seven-bits-per-byte length, nested three
 * deep for the two bytes that actually matter. `Mp4Writer.buildEsds` builds this same tree
 * in the other direction, which is the clearest description of the shape.
 */
function readDecoderSpecificInfo(view: DataView, esds: BoxRef): Uint8Array | null {
  const es = readDescriptor(view, esds.start + 4, esds.end);
  if (!es || es.tag !== 0x03) return null;

  let at = es.start + 3; // ES_ID (2), flags (1)
  const flags = view.getUint8(es.start + 2);
  if (flags & 0x80) at += 2; // depends on another stream
  if (flags & 0x40) at += 1 + view.getUint8(at); // inline URL
  if (flags & 0x20) at += 2; // OCR stream

  const decoderConfig = readDescriptor(view, at, es.end);
  if (!decoderConfig || decoderConfig.tag !== 0x04) return null;

  // objectTypeIndication (1), streamType (1), bufferSize (3), max and average bitrate (8).
  const specific = readDescriptor(view, decoderConfig.start + 13, decoderConfig.end);
  if (!specific || specific.tag !== 0x05 || specific.end <= specific.start) return null;

  return copy(view, specific.start, specific.end);
}

function readDescriptor(
  view: DataView,
  at: number,
  limit: number,
): { tag: number; start: number; end: number } | null {
  if (at + 2 > limit) return null;
  const tag = view.getUint8(at);
  let size = 0;
  let cursor = at + 1;
  for (let i = 0; i < 4 && cursor < limit; i += 1) {
    const byte = view.getUint8(cursor);
    cursor += 1;
    size = (size << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) break;
  }
  const end = Math.min(cursor + size, limit);
  return { tag, start: cursor, end };
}

/** Five bits of object type, with the six-bit escape the spec adds above 30. */
function aacObjectType(asc: Uint8Array): number {
  const first = asc[0] ?? 0;
  const five = first >> 3;
  if (five !== 31) return five;
  return 32 + (((first & 0x07) << 3) | ((asc[1] ?? 0) >> 5));
}

/**
 * Rebuild `OpusHead` from `dOps`.
 *
 * The exact inverse of `Mp4Writer.buildDOps`: same fields, but the header wants the magic
 * back, version 1 rather than 0, and little-endian where the box is big-endian. WebCodecs
 * takes the Ogg-shaped header, not the box.
 */
function opusHeadFrom(view: DataView, dOps: BoxRef): Uint8Array {
  const family = view.getUint8(dOps.start + 10);
  const mapping = family === 0 ? new Uint8Array(0) : copy(view, dOps.start + 11, dOps.end);

  const head = new Uint8Array(19 + mapping.byteLength);
  head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]); // "OpusHead"
  const out = new DataView(head.buffer);
  out.setUint8(8, 1); // version
  out.setUint8(9, view.getUint8(dOps.start + 1)); // channel count
  out.setUint16(10, view.getUint16(dOps.start + 2), true); // pre-skip
  out.setUint32(12, view.getUint32(dOps.start + 4), true); // original sample rate
  out.setUint16(16, view.getUint16(dOps.start + 8), true); // output gain
  out.setUint8(18, family);
  head.set(mapping, 19);
  return head;
}

// --- The sample tables ---------------------------------------------------------------

function readSampleSizes(view: DataView, stbl: BoxRef): number[] {
  const stsz = findBox(view, stbl, 'stsz');
  if (stsz) {
    const uniform = view.getUint32(stsz.start + 4);
    const count = view.getUint32(stsz.start + 8);
    if (uniform > 0) return new Array<number>(count).fill(uniform);
    const sizes = new Array<number>(count);
    for (let i = 0; i < count; i += 1) sizes[i] = view.getUint32(stsz.start + 12 + i * 4);
    return sizes;
  }

  // `stz2` packs the sizes into 4, 8, or 16 bits each. Rare, but a valid file may use it
  // and the alternative to reading it is reporting no audio.
  const stz2 = findBox(view, stbl, 'stz2');
  if (!stz2) return [];
  const fieldSize = view.getUint8(stz2.start + 7);
  const count = view.getUint32(stz2.start + 8);
  const sizes = new Array<number>(count).fill(0);
  for (let i = 0; i < count; i += 1) {
    const at = stz2.start + 12;
    if (fieldSize === 16) sizes[i] = view.getUint16(at + i * 2);
    else if (fieldSize === 8) sizes[i] = view.getUint8(at + i);
    else if (fieldSize === 4) {
      const byte = view.getUint8(at + (i >> 1));
      sizes[i] = i % 2 === 0 ? byte >> 4 : byte & 0x0f;
    }
  }
  return sizes;
}

/** Per-sample durations, expanded from `stts`'s run-length encoding. */
function readSampleDeltas(view: DataView, stbl: BoxRef, sampleCount: number): number[] {
  const stts = findBox(view, stbl, 'stts');
  if (!stts) return [];

  const runs = view.getUint32(stts.start + 4);
  const deltas: number[] = [];
  for (let run = 0; run < runs && deltas.length < sampleCount; run += 1) {
    const at = stts.start + 8 + run * 8;
    if (at + 8 > stts.end) break;
    const count = view.getUint32(at);
    const delta = view.getUint32(at + 4);
    for (let i = 0; i < count && deltas.length < sampleCount; i += 1) deltas.push(delta);
  }
  // A table that ran short describes fewer samples than exist; the tail keeps the last
  // known duration rather than collapsing to zero-length frames.
  while (deltas.length < sampleCount) deltas.push(deltas.at(-1) ?? 0);
  return deltas;
}

/**
 * Absolute file offsets per sample, from the chunk tables.
 *
 * `stco` says where each chunk starts, `stsc` says how many samples are in it, and the
 * sizes walk the cursor forward inside it. The run-length encoding of `stsc` is the fiddly
 * part: an entry applies from its `first_chunk` until the next entry's.
 */
function readSampleOffsets(view: DataView, stbl: BoxRef, sizes: number[]): number[] {
  const stco = findBox(view, stbl, 'stco');
  const co64 = stco ? null : findBox(view, stbl, 'co64');
  const table = stco ?? co64;
  if (!table) return [];

  const chunkCount = view.getUint32(table.start + 4);
  const chunkOffset = (chunk: number): number =>
    co64
      ? Number(view.getBigUint64(table.start + 8 + chunk * 8))
      : view.getUint32(table.start + 8 + chunk * 4);

  const stsc = findBox(view, stbl, 'stsc');
  if (!stsc) return [];
  const runCount = view.getUint32(stsc.start + 4);
  const runs: Array<{ firstChunk: number; perChunk: number }> = [];
  for (let i = 0; i < runCount; i += 1) {
    const at = stsc.start + 8 + i * 12;
    if (at + 12 > stsc.end) break;
    runs.push({ firstChunk: view.getUint32(at), perChunk: view.getUint32(at + 4) });
  }
  if (runs.length === 0) return [];

  const offsets: number[] = [];
  let run = 0;
  for (let chunk = 0; chunk < chunkCount && offsets.length < sizes.length; chunk += 1) {
    while (run + 1 < runs.length && runs[run + 1]!.firstChunk <= chunk + 1) run += 1;
    let at = chunkOffset(chunk);
    for (let i = 0; i < runs[run]!.perChunk && offsets.length < sizes.length; i += 1) {
      offsets.push(at);
      at += sizes[offsets.length - 1]!;
    }
  }
  return offsets;
}

function copy(view: DataView, from: number, to: number): Uint8Array {
  return new Uint8Array(view.buffer.slice(view.byteOffset + from, view.byteOffset + to));
}
