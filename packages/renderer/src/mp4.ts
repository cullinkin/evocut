/**
 * An MP4 writer, in about as few bytes of code as the format allows.
 *
 * ## Why write one
 *
 * WebCodecs encodes; it does not package. `VideoEncoder` hands back a stream of
 * `EncodedVideoChunk`s and a `description` blob, and there is no browser API that turns
 * those into a file anyone can play. Something has to lay out `ftyp`, `moov`, and `mdat`
 * and build the sample tables, and for EvoCut that something is this file — the export is
 * meant to be ours end to end, and a muxer is the one part of "our own renderer" that
 * cannot be delegated to the platform.
 *
 * ## Shape of the output
 *
 * Progressive, not fragmented: `ftyp` + `moov` + `mdat`, with `moov` written *before* the
 * media data so the file opens instantly instead of after a full scan. That costs a second
 * pass over the sample tables (offsets depend on the size of the box that records them) and
 * it means the whole file is assembled before any of it exists — acceptable, because a
 * phone edit is seconds to minutes, and every sample is already in memory by then anyway.
 *
 * Every sample gets its own chunk. That is more `stco` entries than a tuned muxer would
 * write (four bytes per frame), and in exchange samples may be laid down in any order —
 * so video and audio interleave by timestamp without any bookkeeping.
 *
 * ## What it does not do
 *
 * No B-frames: `ctts` is never written, so presentation order is decode order. The encoder
 * configuration in `render.ts` asks for a baseline-family profile precisely to keep that
 * true. No edit lists, so a codec's own priming delay (AAC has one) is not compensated —
 * worth knowing if audio ever drifts a frame ahead of picture.
 */

const ascii = new TextEncoder();

export interface Mp4Sample {
  data: Uint8Array;
  /** Presentation time in microseconds, on the output timeline. */
  timestampUs: number;
  /** Only consulted for the final sample of a track; the rest infer from the next one. */
  durationUs?: number;
  /** A sample that can be decoded without any earlier one. */
  key?: boolean;
}

export interface VideoTrackInit {
  /** WebCodecs codec string, e.g. `avc1.42E01F` or `vp09.00.10.08`. */
  codec: string;
  /** `avcC` payload from the encoder's metadata. Required for AVC, unused for VP9. */
  description?: Uint8Array;
  width: number;
  height: number;
}

export interface AudioTrackInit {
  /** WebCodecs codec string: `mp4a.40.2` or `opus`. */
  codec: string;
  /** AudioSpecificConfig for AAC, or the `OpusHead` the encoder hands back for Opus. */
  description?: Uint8Array;
  sampleRate: number;
  channels: number;
}

interface TrackState {
  id: number;
  kind: 'video' | 'audio';
  codec: string;
  timescale: number;
  samples: Mp4Sample[];
  description: Uint8Array;
  width: number;
  height: number;
  sampleRate: number;
  channels: number;
}

/** Movie header timescale. Milliseconds is plenty for a duration nobody seeks with. */
const MOVIE_TIMESCALE = 1000;
/** Video runs on a microsecond timebase, so WebCodecs timestamps land exactly. */
const VIDEO_TIMESCALE = 1_000_000;

export class Mp4Writer {
  #tracks: TrackState[] = [];

  addVideoTrack(init: VideoTrackInit): number {
    if (isAvc(init.codec) && !init.description) {
      throw new Error('An AVC track needs the avcC description from the encoder.');
    }
    return this.#addTrack({
      kind: 'video',
      codec: init.codec,
      timescale: VIDEO_TIMESCALE,
      description: init.description ?? new Uint8Array(0),
      width: init.width,
      height: init.height,
      sampleRate: 0,
      channels: 0,
    });
  }

  addAudioTrack(init: AudioTrackInit): number {
    if (isOpus(init.codec) && !init.description) {
      throw new Error('An Opus track needs the OpusHead description from the encoder.');
    }
    return this.#addTrack({
      kind: 'audio',
      codec: init.codec,
      // The audio timebase is the sample rate, so a frame of 1024 samples has an exact
      // integer duration. At a microsecond timebase it would not, and the rounding error
      // would accumulate into audible drift over a few minutes.
      timescale: init.sampleRate,
      // AAC is the one codec whose configuration is fully derivable from the rate and
      // channel count, so an encoder that supplies no description is not a problem.
      description: init.description ?? audioSpecificConfig(init.sampleRate, init.channels),
      width: 0,
      height: 0,
      sampleRate: init.sampleRate,
      channels: init.channels,
    });
  }

  #addTrack(state: Omit<TrackState, 'id' | 'samples'>): number {
    this.#tracks.push({ ...state, id: this.#tracks.length + 1, samples: [] });
    return this.#tracks.length - 1;
  }

  addSample(track: number, sample: Mp4Sample): void {
    const state = this.#tracks[track];
    if (!state) throw new Error(`No such track: ${track}`);
    state.samples.push(sample);
  }

  sampleCount(track: number): number {
    return this.#tracks[track]?.samples.length ?? 0;
  }

  /** True once at least one track has something to write. */
  get hasSamples(): boolean {
    return this.#tracks.some((track) => track.samples.length > 0);
  }

  /**
   * Assemble the file.
   *
   * Returns a `Blob` built from the sample buffers rather than one flat array: the media
   * data is the overwhelming majority of the bytes and copying it again, on a phone, to
   * produce a value that is immediately handed to `URL.createObjectURL` would be a
   * gratuitous doubling of peak memory.
   */
  finalize(): { blob: Blob; durationUs: number } {
    const tracks = this.#tracks.filter((track) => track.samples.length > 0);
    if (tracks.length === 0) throw new Error('Nothing to write: no samples were added.');

    const timings = tracks.map((track) => timeTrack(track));

    // Samples are laid down in presentation order across all tracks, so a player reading
    // forward always has the audio it needs for the picture it just decoded.
    const order = tracks
      .flatMap((track, trackIndex) =>
        track.samples.map((sample, sampleIndex) => ({ trackIndex, sampleIndex, at: sample.timestampUs })),
      )
      .sort((a, b) => a.at - b.at || a.trackIndex - b.trackIndex);

    const offsets = tracks.map((track) => new Array<number>(track.samples.length).fill(0));
    const ftyp = buildFtyp();

    const durationUs = Math.max(...timings.map((timing) => timing.durationUs));
    // The offsets depend on the size of the box that stores them, so `moov` is built once
    // to measure and once for real. Nothing about its length varies with the values.
    const measured = buildMoov(tracks, timings, offsets, durationUs);
    const mediaStart = ftyp.length + measured.length + 8;

    let cursor = mediaStart;
    for (const entry of order) {
      offsets[entry.trackIndex]![entry.sampleIndex] = cursor;
      cursor += tracks[entry.trackIndex]!.samples[entry.sampleIndex]!.data.byteLength;
    }
    const mediaLength = cursor - mediaStart;
    if (cursor > 0xffff_ffff) {
      throw new Error('Export is larger than 4GB, which this writer cannot address.');
    }

    const moov = buildMoov(tracks, timings, offsets, durationUs);
    if (moov.length !== measured.length) {
      throw new Error('Internal error: moov size changed between passes.');
    }

    const parts: BlobPart[] = [
      toPart(ftyp),
      toPart(moov),
      toPart(concat([u32(mediaLength + 8), ascii.encode('mdat')])),
      ...order.map((entry) => toPart(tracks[entry.trackIndex]!.samples[entry.sampleIndex]!.data)),
    ];

    return { blob: new Blob(parts, { type: 'video/mp4' }), durationUs };
  }
}

/** Per-sample durations, plus the track's total, all in the track's own timescale. */
interface TrackTiming {
  /** Start time of each sample, in the track timescale. */
  starts: number[];
  /** Duration of each sample, in the track timescale. */
  durations: number[];
  /** Total, in the track timescale. */
  duration: number;
  durationUs: number;
}

function timeTrack(track: TrackState): TrackTiming {
  const scale = (us: number) => Math.round((us * track.timescale) / 1_000_000);

  // An encoder may emit a negative first timestamp to describe its own priming samples.
  // Nothing in MP4's version-0 boxes can express a negative time, so the track is shifted
  // to start at zero. Both of our tracks start at output time zero, so this only ever
  // moves a track by its codec delay.
  let base = 0;
  for (const sample of track.samples) base = Math.min(base, sample.timestampUs);
  const starts = track.samples.map((sample) => scale(sample.timestampUs - base));

  const durations: number[] = [];
  for (const [index, start] of starts.entries()) {
    const next = starts[index + 1];
    if (next !== undefined) {
      durations.push(Math.max(1, next - start));
      continue;
    }
    const declared = track.samples[index]!.durationUs;
    // Last sample: use what the caller declared, or assume it runs as long as the one
    // before it. Getting this wrong truncates or extends the final frame, nothing more.
    durations.push(Math.max(1, declared !== undefined ? scale(declared) : (durations[index - 1] ?? 1)));
  }

  const duration = (starts.at(-1) ?? 0) + (durations.at(-1) ?? 0);
  return {
    starts,
    durations,
    duration,
    durationUs: Math.round((duration * 1_000_000) / track.timescale),
  };
}

function buildFtyp(): Uint8Array {
  return box(
    'ftyp',
    ascii.encode('isom'),
    u32(0x200),
    ascii.encode('isom'),
    ascii.encode('iso2'),
    ascii.encode('avc1'),
    ascii.encode('mp41'),
  );
}

function buildMoov(
  tracks: TrackState[],
  timings: TrackTiming[],
  offsets: number[][],
  durationUs: number,
): Uint8Array {
  const movieDuration = Math.round((durationUs * MOVIE_TIMESCALE) / 1_000_000);
  return box(
    'moov',
    buildMvhd(movieDuration, tracks.length + 1),
    ...tracks.map((track, index) => buildTrak(track, timings[index]!, offsets[index]!, movieDuration)),
  );
}

function buildMvhd(duration: number, nextTrackId: number): Uint8Array {
  return fullBox(
    'mvhd',
    0,
    0,
    u32(0), // creation time
    u32(0), // modification time
    u32(MOVIE_TIMESCALE),
    u32(duration),
    u32(0x0001_0000), // rate 1.0
    u16(0x0100), // volume 1.0
    new Uint8Array(10), // reserved
    IDENTITY_MATRIX,
    new Uint8Array(24), // pre_defined
    u32(nextTrackId),
  );
}

function buildTrak(
  track: TrackState,
  timing: TrackTiming,
  offsets: number[],
  movieDuration: number,
): Uint8Array {
  return box('trak', buildTkhd(track, movieDuration), buildMdia(track, timing, offsets));
}

function buildTkhd(track: TrackState, movieDuration: number): Uint8Array {
  const video = track.kind === 'video';
  return fullBox(
    'tkhd',
    0,
    0x000007, // enabled, in movie, in preview
    u32(0),
    u32(0),
    u32(track.id),
    u32(0), // reserved
    u32(movieDuration),
    new Uint8Array(8), // reserved
    u16(0), // layer
    u16(0), // alternate group
    u16(video ? 0 : 0x0100), // volume
    u16(0), // reserved
    IDENTITY_MATRIX,
    u32(video ? track.width * 0x10000 : 0),
    u32(video ? track.height * 0x10000 : 0),
  );
}

function buildMdia(track: TrackState, timing: TrackTiming, offsets: number[]): Uint8Array {
  return box(
    'mdia',
    fullBox(
      'mdhd',
      0,
      0,
      u32(0),
      u32(0),
      u32(track.timescale),
      u32(timing.duration),
      u16(0x55c4), // language: "und"
      u16(0),
    ),
    fullBox(
      'hdlr',
      0,
      0,
      u32(0),
      ascii.encode(track.kind === 'video' ? 'vide' : 'soun'),
      new Uint8Array(12),
      ascii.encode(track.kind === 'video' ? 'EvoCut Video\0' : 'EvoCut Audio\0'),
    ),
    buildMinf(track, timing, offsets),
  );
}

function buildMinf(track: TrackState, timing: TrackTiming, offsets: number[]): Uint8Array {
  const header =
    track.kind === 'video'
      ? fullBox('vmhd', 0, 1, u16(0), new Uint8Array(6))
      : fullBox('smhd', 0, 0, u16(0), u16(0));

  return box(
    'minf',
    header,
    box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
    buildStbl(track, timing, offsets),
  );
}

function buildStbl(track: TrackState, timing: TrackTiming, offsets: number[]): Uint8Array {
  const syncSamples = track.samples
    .map((sample, index) => ({ sample, index }))
    .filter(({ sample }) => sample.key)
    .map(({ index }) => index + 1);
  // An all-key track omits `stss` entirely: its presence with every index listed says the
  // same thing at four bytes a frame.
  const everySampleIsKey = syncSamples.length === track.samples.length;

  return box(
    'stbl',
    fullBox('stsd', 0, 0, u32(1), buildSampleEntry(track)),
    buildStts(timing.durations),
    ...(everySampleIsKey ? [] : [fullBox('stss', 0, 0, u32Array([syncSamples.length, ...syncSamples]))]),
    // One sample per chunk: first_chunk 1, samples_per_chunk 1, description 1.
    fullBox('stsc', 0, 0, u32Array([1, 1, 1, 1])),
    fullBox(
      'stsz',
      0,
      0,
      u32Array([0, track.samples.length, ...track.samples.map((sample) => sample.data.byteLength)]),
    ),
    fullBox('stco', 0, 0, u32Array([offsets.length, ...offsets])),
  );
}

/**
 * The sample entry: which codec, and how to configure its decoder.
 *
 * Four are supported, in two pairs. AVC and AAC are what an iPhone records and what its
 * Photos library accepts, so they are what an export aims for. VP9 and Opus are the
 * fallback for a browser without the patent-encumbered pair — which includes the Chromium
 * the export's own end-to-end check runs in, so this is not a hypothetical branch: it is
 * the one path that can be exercised offline.
 */
function buildSampleEntry(track: TrackState): Uint8Array {
  if (track.kind === 'video') {
    const config = isAvc(track.codec) ? box('avcC', track.description) : buildVpcC(track.codec);
    return box(
      isAvc(track.codec) ? 'avc1' : 'vp09',
      new Uint8Array(6), // reserved
      u16(1), // data_reference_index
      u16(0), // pre_defined
      u16(0), // reserved
      new Uint8Array(12), // pre_defined
      u16(track.width),
      u16(track.height),
      u32(0x0048_0000), // 72dpi horizontal
      u32(0x0048_0000), // 72dpi vertical
      u32(0), // reserved
      u16(1), // frame_count
      new Uint8Array(32), // compressorname
      u16(0x0018), // depth
      u16(0xffff), // pre_defined
      config,
    );
  }

  return box(
    isOpus(track.codec) ? 'Opus' : 'mp4a',
    new Uint8Array(6),
    u16(1), // data_reference_index
    u32(0), // version / revision
    u32(0), // vendor
    u16(track.channels),
    u16(16), // sample size
    u16(0), // pre_defined
    u16(0), // reserved
    u32(track.sampleRate * 0x10000), // 16.16 fixed point
    isOpus(track.codec) ? buildDOps(track) : buildEsds(track),
  );
}

function isAvc(codec: string): boolean {
  return codec.startsWith('avc1') || codec.startsWith('avc3');
}

function isOpus(codec: string): boolean {
  return codec === 'opus' || codec.startsWith('opus.');
}

/**
 * VP9's configuration record, derived from the codec string rather than the encoder.
 *
 * Unlike AVC, VP9 needs no out-of-band parameter sets — everything a decoder wants is in
 * the bitstream — so browsers hand back no `description` at all, and `vp09.00.10.08`
 * (profile, level, bit depth) is the whole of what this box has to say.
 */
function buildVpcC(codec: string): Uint8Array {
  const [, profile = '00', level = '10', depth = '08'] = codec.split('.');
  const CHROMA_420_COLOCATED = 1;
  const FULL_RANGE = 0;
  return fullBox(
    'vpcC',
    1,
    0,
    u8(Number(profile)),
    u8(Number(level)),
    u8((Number(depth) << 4) | (CHROMA_420_COLOCATED << 1) | FULL_RANGE),
    u8(1), // colour primaries: BT.709
    u8(1), // transfer characteristics: BT.709
    u8(1), // matrix coefficients: BT.709
    u16(0), // no codec initialization data
  );
}

/**
 * Opus's configuration record, transcribed from the `OpusHead` the encoder supplies.
 *
 * Same fields, three differences: no magic signature, the version is 0 rather than 1, and
 * the multi-byte fields are big-endian here where Ogg's are little-endian. Copying it
 * across verbatim produces a file that plays at the wrong rate, which is a memorable way
 * to discover that two specs describe the same data twice.
 */
function buildDOps(track: TrackState): Uint8Array {
  const head = track.description;
  if (head.byteLength < 19) throw new Error('OpusHead is too short to be valid.');
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  return box(
    'dOps',
    u8(0), // version
    u8(head[9]!), // output channel count
    u16(view.getUint16(10, true)), // pre-skip
    u32(view.getUint32(12, true)), // original input sample rate
    u16(view.getUint16(16, true)), // output gain, Q7.8
    u8(head[18]!), // channel mapping family
    // Family 0 is mono or stereo and carries no mapping table; anything else does, and it
    // follows the header unchanged in both formats.
    head[18] === 0 ? new Uint8Array(0) : head.subarray(19),
  );
}

/**
 * The AAC decoder configuration, wrapped in MPEG-4 descriptors.
 *
 * This is the one genuinely baroque corner of the format: a tree of tag/length descriptors
 * inside a box, whose only real payload is the two-byte AudioSpecificConfig at the bottom.
 */
function buildEsds(track: TrackState): Uint8Array {
  const decoderSpecific = descriptor(0x05, track.description);
  const decoderConfig = descriptor(
    0x04,
    concat([
      u8(0x40), // MPEG-4 audio
      u8(0x15), // stream type: audio, not upstream
      u24(0), // buffer size
      u32(0), // max bitrate — unknown, and no player insists
      u32(0),
      decoderSpecific,
    ]),
  );
  const es = descriptor(
    0x03,
    concat([
      u16(track.id),
      u8(0), // no stream dependency, no URL, no OCR
      decoderConfig,
      descriptor(0x06, u8(0x02)), // SLConfig: predefined
    ]),
  );
  return fullBox('esds', 0, 0, es);
}

/**
 * AudioSpecificConfig for AAC-LC, for encoders that do not supply one.
 *
 * Five bits of object type, four of sample rate index, four of channel configuration —
 * packed across two bytes, which is why this is bit twiddling rather than a struct.
 */
export function audioSpecificConfig(sampleRate: number, channels: number): Uint8Array {
  const rates = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
  ];
  const index = rates.indexOf(sampleRate);
  if (index === -1) throw new Error(`Unsupported AAC sample rate: ${sampleRate}`);
  const objectType = 2; // AAC-LC
  return new Uint8Array([
    (objectType << 3) | (index >> 1),
    ((index & 1) << 7) | (channels << 3),
  ]);
}

/** Tag, then a length in the format's own seven-bits-per-byte encoding, then the payload. */
function descriptor(tag: number, payload: Uint8Array): Uint8Array {
  const size = payload.byteLength;
  return concat([
    u8(tag),
    new Uint8Array([
      0x80 | ((size >> 21) & 0x7f),
      0x80 | ((size >> 14) & 0x7f),
      0x80 | ((size >> 7) & 0x7f),
      size & 0x7f,
    ]),
    payload,
  ]);
}

/**
 * The time-to-sample table: consecutive equal durations collapsed into (count, delta) runs.
 *
 * At a constant frame rate this is one run for the whole track, which is why a table that
 * would otherwise be four bytes per frame is usually sixteen bytes total.
 */
function buildStts(durations: number[]): Uint8Array {
  const runs: Array<{ count: number; value: number }> = [];
  for (const value of durations) {
    const last = runs.at(-1);
    if (last && last.value === value) last.count += 1;
    else runs.push({ count: 1, value });
  }
  return fullBox('stts', 0, 0, u32Array([runs.length, ...runs.flatMap((run) => [run.count, run.value])]));
}

const IDENTITY_MATRIX = concat([
  u32(0x0001_0000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x0001_0000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x4000_0000),
]);

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const payload = concat(parts);
  return concat([u32(payload.byteLength + 8), ascii.encode(type), payload]);
}

function fullBox(type: string, version: number, flags: number, ...parts: Uint8Array[]): Uint8Array {
  return box(type, u8(version), u24(flags), ...parts);
}

function u8(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function u16(value: number): Uint8Array {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}

function u24(value: number): Uint8Array {
  return new Uint8Array([(value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function u32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function u32Array(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value >>> 0));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/**
 * `Uint8Array` is a valid `BlobPart` but its type parameter varies between the DOM and
 * Node typings, so this is the one place that difference is absorbed.
 */
function toPart(bytes: Uint8Array): BlobPart {
  return bytes as unknown as BlobPart;
}
