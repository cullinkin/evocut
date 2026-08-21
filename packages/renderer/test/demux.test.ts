import { describe, expect, it } from 'vitest';
import { Mp4Writer, audioSpecificConfig } from '../src/mp4.js';
import {
  describeAudioTrack,
  readAudioTrack,
  readVideoFrameRate,
  readVideoTrack,
  readVideoWeights,
} from '../src/demux.js';

/**
 * The demuxer, checked against the muxer.
 *
 * These two are the only pair of components in the project that can validate each other:
 * one writes the index, the other reads it, and neither shares a line of code with the
 * other. A round trip that recovers the codec, the configuration record, and — the part
 * that actually matters — the exact byte range of every audio frame, is a strong statement
 * that the parser reads real files, because the file it just read was assembled from the
 * spec independently.
 *
 * The video track is not decoration. It forces the audio frames to be scattered through
 * `mdat` rather than laid end to end, which is the case a parser that quietly assumed
 * contiguity would pass without it, and fail on every real recording.
 */

// --- Just enough box building to write a fixture by hand ------------------------------

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

function ascii(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0);
  return out;
}

function u64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const payload = concat(parts);
  return concat([u32(payload.byteLength + 8), ascii(type), payload]);
}

function fullBox(type: string, ...parts: Uint8Array[]): Uint8Array {
  return box(type, new Uint8Array(4), ...parts);
}

/** An `mp4a` entry carrying an AAC-LC configuration, descriptors and all. */
function sampleEntry(): Uint8Array {
  const asc = audioSpecificConfig(48_000, 2);
  const descriptor = (tag: number, payload: Uint8Array) =>
    concat([new Uint8Array([tag, payload.byteLength & 0x7f]), payload]);
  const esds = fullBox(
    'esds',
    descriptor(
      0x03,
      concat([
        new Uint8Array([0, 1, 0]),
        descriptor(
          0x04,
          concat([new Uint8Array([0x40, 0x15]), new Uint8Array(11), descriptor(0x05, asc)]),
        ),
      ]),
    ),
  );
  return box(
    'mp4a',
    new Uint8Array(6),
    new Uint8Array([0, 1]), // data_reference_index
    new Uint8Array(8), // version, revision, vendor
    new Uint8Array([0, 2]), // channel count
    new Uint8Array([0, 16]), // sample size
    new Uint8Array(4), // pre_defined, reserved
    u32(48_000 * 0x10000),
    esds,
  );
}

const SAMPLE_RATE = 48_000;
const FRAMES_PER_PACKET = 1024;

function audioFrame(index: number): Uint8Array {
  // Distinct lengths and distinct contents, so a frame recovered from the wrong offset
  // reads as the wrong frame rather than as plausible noise.
  const size = 40 + (index % 7) * 3;
  return new Uint8Array(size).fill(index + 1);
}

function timestampFor(index: number): number {
  return Math.round((index * FRAMES_PER_PACKET * 1_000_000) / SAMPLE_RATE);
}

/** An MP4 with interleaved video and audio, and a known audio layout. */
function buildFile(options: { codec?: string; description?: Uint8Array; count?: number } = {}) {
  const count = options.count ?? 12;
  const writer = new Mp4Writer();

  const video = writer.addVideoTrack({ codec: 'vp09.00.10.08', width: 64, height: 64 });
  for (let i = 0; i < count; i += 1) {
    writer.addSample(video, {
      data: new Uint8Array(500).fill(0xaa),
      timestampUs: Math.round((i * 1_000_000) / 30),
      durationUs: Math.round(1_000_000 / 30),
      key: i === 0,
    });
  }

  const audio = writer.addAudioTrack({
    codec: options.codec ?? 'mp4a.40.2',
    ...(options.description ? { description: options.description } : {}),
    sampleRate: SAMPLE_RATE,
    channels: 2,
  });
  const frames: Uint8Array[] = [];
  for (let i = 0; i < count; i += 1) {
    const data = audioFrame(i);
    frames.push(data);
    writer.addSample(audio, {
      data,
      timestampUs: timestampFor(i),
      durationUs: Math.round((FRAMES_PER_PACKET * 1_000_000) / SAMPLE_RATE),
    });
  }

  return { blob: writer.finalize().blob, frames };
}

describe('readAudioTrack', () => {
  it('finds the sound track past the video track and describes its format', async () => {
    const track = await readAudioTrack(buildFile().blob);

    expect(track?.codec).toBe('mp4a.40.2');
    expect(track?.sampleRate).toBe(SAMPLE_RATE);
    expect(track?.channels).toBe(2);
    // The writer synthesises an AudioSpecificConfig when the encoder supplies none; this
    // is that same record, recovered from three levels of MPEG-4 descriptor nesting.
    expect(track?.description).toEqual(audioSpecificConfig(SAMPLE_RATE, 2));
  });

  it('recovers the exact bytes of every audio frame, and nothing else', async () => {
    const { blob, frames } = buildFile();
    const track = await readAudioTrack(blob);
    expect(track?.samples).toHaveLength(frames.length);

    for (const [index, sample] of track!.samples.entries()) {
      const expected = frames[index]!;
      expect(sample.size).toBe(expected.byteLength);
      const read = new Uint8Array(await blob.slice(sample.offset, sample.offset + sample.size).arrayBuffer());
      expect([...read]).toEqual([...expected]);
    }

    // Audio is a small fraction of the file, which is the whole reason for reading it this
    // way rather than decoding the container.
    expect(track!.byteLength).toBeLessThan(blob.size / 4);
  });

  it('puts every frame back on the source clock', async () => {
    const track = await readAudioTrack(buildFile().blob);
    expect(track!.samples.map((sample) => sample.timestampUs)).toEqual(
      track!.samples.map((_, index) => timestampFor(index)),
    );
    expect(track!.durationUs).toBe(timestampFor(track!.samples.length));
  });

  it('transcribes dOps back into the OpusHead a decoder wants', async () => {
    // "OpusHead", version 1, 2 channels, 312 samples of pre-skip, 48kHz, no gain, family 0
    const head = new Uint8Array([
      0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 2, 0x38, 0x01, 0x80, 0xbb, 0x00, 0x00,
      0x00, 0x00, 0,
    ]);
    const track = await readAudioTrack(buildFile({ codec: 'opus', description: head }).blob);

    expect(track?.codec).toBe('opus');
    expect(track?.channels).toBe(2);
    // Round-tripped through the box's big-endian fields and back to Ogg's little-endian
    // ones. Copying it across verbatim in either direction plays at the wrong rate.
    expect(track?.description).toEqual(head);
  });

  it('returns nothing rather than throwing on a container it cannot read', async () => {
    expect(await readAudioTrack(new Blob([new Uint8Array(0)]))).toBeNull();
    expect(await readAudioTrack(new Blob([new Uint8Array(4096).fill(0x1f)]))).toBeNull();
    // A Matroska file: a real container, and not this one.
    expect(await readAudioTrack(new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 8])]))).toBeNull();
  });

  it('returns nothing for a file with no sound at all', async () => {
    const writer = new Mp4Writer();
    const video = writer.addVideoTrack({ codec: 'vp09.00.10.08', width: 64, height: 64 });
    writer.addSample(video, { data: new Uint8Array(64), timestampUs: 0, durationUs: 33_333, key: true });
    expect(await readAudioTrack(writer.finalize().blob)).toBeNull();
  });

  /**
   * Real files are not shaped like ours.
   *
   * `Mp4Writer` puts one sample in every chunk, which means a round trip against it never
   * walks *inside* a chunk — and a parser that got that walk wrong would pass every test
   * above while misreading every file a phone has ever written. Recorders pack a second or
   * so of audio into each chunk, address `mdat` with 64-bit offsets once a file passes 4 GB,
   * and mark the codec's priming delay with an edit list.
   *
   * So this fixture is built by hand, to the spec rather than to our writer, with a
   * deliberate gap between chunks: a parser that assumed frames run end to end reads the
   * padding and fails loudly instead of quietly.
   */
  interface CompactLayout {
    sizes: number[];
    samplesPerChunk: number;
    use64?: boolean;
    uniformSize?: number;
    primingSamples?: number;
  }

  const TIMESCALE = 48_000;
  const PACKET = 1024;
  /** Stands in for the video between two audio chunks. */
  const CHUNK_GAP = 300;

  function buildCompact(layout: CompactLayout) {
    const { sizes, samplesPerChunk, use64 = false, uniformSize = 0, primingSamples = 0 } = layout;
    const chunks: number[][] = [];
    for (let i = 0; i < sizes.length; i += samplesPerChunk) {
      chunks.push(sizes.slice(i, i + samplesPerChunk));
    }

    const frames = sizes.map((size, index) => new Uint8Array(size).fill((index % 250) + 1));
    const stsz = uniformSize
      ? fullBox('stsz', u32(uniformSize), u32(sizes.length))
      : fullBox('stsz', u32(0), u32(sizes.length), ...sizes.map(u32));

    const build = (chunkOffsets: number[]) =>
      concat([
        box('ftyp', ascii('isom'), u32(0x200), ascii('isom')),
        box(
          'moov',
          box(
            'trak',
            ...(primingSamples
              ? [box('edts', fullBox('elst', u32(1), u32(9999), u32(primingSamples), u32(0x10000)))]
              : []),
            box(
              'mdia',
              fullBox('mdhd', u32(0), u32(0), u32(TIMESCALE), u32(PACKET * sizes.length), u32(0)),
              fullBox('hdlr', u32(0), ascii('soun'), new Uint8Array(13)),
              box(
                'minf',
                box(
                  'stbl',
                  fullBox('stsd', u32(1), sampleEntry()),
                  fullBox('stts', u32(1), u32(sizes.length), u32(PACKET)),
                  fullBox('stsc', u32(1), u32(1), u32(samplesPerChunk), u32(1)),
                  stsz,
                  use64
                    ? fullBox('co64', u32(chunkOffsets.length), ...chunkOffsets.map(u64))
                    : fullBox('stco', u32(chunkOffsets.length), ...chunkOffsets.map(u32)),
                ),
              ),
            ),
          ),
        ),
      ]);

    // Two passes, for the same reason the writer needs two: the offsets depend on the size
    // of the box that holds them.
    const mdatStart = build(chunks.map(() => 0)).byteLength + 8;
    const offsets: number[] = [];
    const media: Uint8Array[] = [];
    let at = mdatStart;
    let frame = 0;
    for (const chunk of chunks) {
      offsets.push(at);
      for (let i = 0; i < chunk.length; i += 1) {
        media.push(frames[frame]!);
        at += frames[frame]!.byteLength;
        frame += 1;
      }
      media.push(new Uint8Array(CHUNK_GAP).fill(0xee));
      at += CHUNK_GAP;
    }

    const payload = concat(media);
    return {
      blob: new Blob([
        build(offsets) as unknown as BlobPart,
        concat([u32(payload.byteLength + 8), ascii('mdat'), payload]) as unknown as BlobPart,
      ]),
      frames,
    };
  }

  async function expectFramesRecovered(layout: CompactLayout) {
    const { blob, frames } = buildCompact(layout);
    const track = await readAudioTrack(blob);
    expect(track?.samples).toHaveLength(frames.length);

    for (const [index, sample] of track!.samples.entries()) {
      const read = new Uint8Array(await blob.slice(sample.offset, sample.offset + sample.size).arrayBuffer());
      expect([...read]).toEqual([...frames[index]!]);
    }
    return track!;
  }

  it('walks inside a chunk that holds many frames', async () => {
    await expectFramesRecovered({ sizes: [61, 47, 53, 44, 59, 41, 50, 66, 43], samplesPerChunk: 4 });
  });

  it('reads 64-bit chunk offsets', async () => {
    const track = await expectFramesRecovered({ sizes: [61, 47, 53, 44], samplesPerChunk: 2, use64: true });
    expect(track.codec).toBe('mp4a.40.2');
  });

  it('reads a table of equally sized frames', async () => {
    await expectFramesRecovered({ sizes: [48, 48, 48, 48, 48, 48], samplesPerChunk: 3, uniformSize: 48 });
  });

  it('shifts the clock back by the priming delay an edit list declares', async () => {
    const track = await expectFramesRecovered({
      sizes: [61, 47, 53, 44],
      samplesPerChunk: 2,
      primingSamples: PACKET / 2,
    });
    // Half a packet of priming: the first real sample is presented half a packet early,
    // so a trim written against the phone's own timeline lands where the user put it.
    expect(track.samples[0]!.timestampUs).toBe(Math.round((-PACKET / 2 / TIMESCALE) * 1_000_000));
    expect(track.samples[1]!.timestampUs).toBe(Math.round((PACKET / 2 / TIMESCALE) * 1_000_000));
  });

  it('says what it found, in one line', async () => {
    const track = await readAudioTrack(buildFile().blob);
    expect(describeAudioTrack(track)).toMatch(/^mp4a\.40\.2 2ch 48000Hz, 0\.3s, 12 frames, 0\.0MB$/);
    expect(describeAudioTrack(null)).toBe('no readable audio track');
  });
});

/**
 * The frame rate, which nothing else in the browser will tell us.
 *
 * A `<video>` element reports duration and dimensions and stops there, so every import used
 * a nominal 30fps. That was harmless while the rate was decoration; it stopped being
 * harmless when the timeline ruler started counting frames, because a mark reading `15f`
 * half a second into a 60fps recording is a lie the user aims a cut at.
 *
 * Written as durations rather than a rate, because that is what the container holds: `stts`
 * says how long each sample lasts and the rate is inferred from it.
 */
function videoAt(durationsUs: number[]): Blob {
  const writer = new Mp4Writer();
  const track = writer.addVideoTrack({ codec: 'vp09.00.10.08', width: 64, height: 64 });
  let at = 0;
  for (const [index, durationUs] of durationsUs.entries()) {
    writer.addSample(track, {
      data: new Uint8Array(64).fill(0xaa),
      timestampUs: at,
      durationUs,
      key: index === 0,
    });
    at += durationUs;
  }
  // An audio track after it, so the reader has to skip past one to find the picture.
  const audio = writer.addAudioTrack({ codec: 'mp4a.40.2', sampleRate: SAMPLE_RATE, channels: 2 });
  writer.addSample(audio, { data: audioFrame(0), timestampUs: 0, durationUs: 21_333 });
  return writer.finalize().blob;
}

const constant = (count: number, durationUs: number) => new Array(count).fill(durationUs);

describe('readVideoFrameRate', () => {
  it('reads a constant rate off the sample table', async () => {
    // 40ms a frame is 25fps, and the writer's microsecond timebase divides it exactly — so
    // this checks the reduction too: 1000000/40000 has to come back as 25/1, not as itself.
    expect(await readVideoFrameRate(videoAt(constant(50, 40_000)))).toEqual({
      frameRate: { num: 25, den: 1 },
      variable: false,
    });
    expect(await readVideoFrameRate(videoAt(constant(50, 20_000)))).toEqual({
      frameRate: { num: 50, den: 1 },
      variable: false,
    });
  });

  it('tells 60fps from 30fps, which is the whole point of reading it', async () => {
    const sixty = await readVideoFrameRate(videoAt(constant(60, 16_667)));
    // Not 60/1 — the writer's timebase cannot express a sixtieth of a second — but the
    // ruler asks for a number, and this one rounds to sixty rather than to thirty.
    expect(sixty!.frameRate.num / sixty!.frameRate.den).toBeCloseTo(60, 1);
  });

  it('takes the commonest duration when a recording varies, and says that it did', async () => {
    /*
      A phone that dropped its rate in low light writes a `stts` full of different deltas.
      The commonest one is still the answer worth showing — it is what most of the footage
      was shot at — but the caller is told, because a frame ruler over that footage is an
      approximation and the EDL records it as one.
    */
    const mixed = [...constant(40, 40_000), ...constant(10, 80_000)];
    const rate = await readVideoFrameRate(videoAt(mixed));
    expect(rate?.frameRate).toEqual({ num: 25, den: 1 });
    expect(rate?.variable).toBe(true);

    // A handful of odd frames in an otherwise steady take is not variable frame rate.
    const nearly = [...constant(97, 40_000), ...constant(3, 41_000)];
    expect((await readVideoFrameRate(videoAt(nearly)))?.variable).toBe(false);
  });

  it('returns nothing rather than guessing, on a file it cannot read', async () => {
    expect(await readVideoFrameRate(new Blob([new Uint8Array(64)]))).toBe(null);
    // Audio only: there is no video track to have a frame rate.
    expect(await readVideoFrameRate(buildAudioOnly())).toBe(null);
  });
});

describe('readVideoTrack', () => {
  /*
    Everything a `VideoDecoder` needs, without a `<video>` element.

    The proxy is why: captured through a media element it runs at playback speed, because a
    decoder presents frames when a screen would show them. Fed straight into a decoder the
    same hardware runs several times faster, and this is the index that makes that possible.
  */
  it('reads the codec, the configuration and every frame', async () => {
    const track = (await readVideoTrack(videoWeighing([9000, 120, 130, 4000], { keyEvery: 2 })))!;

    expect(track.codec).toMatch(/^vp09\./);
    expect(track.codedWidth).toBe(64);
    expect(track.codedHeight).toBe(64);
    expect(track.count).toBe(4);
    expect([...track.sizes]).toEqual([9000, 120, 130, 4000]);
    expect([...track.timesUs]).toEqual([0, 40_000, 80_000, 120_000]);
    expect([...track.keys]).toEqual([1, 0, 1, 0]);
  });

  it('reads where each frame is, so it can be sliced out without decoding', async () => {
    const file = videoWeighing([100, 200, 300], { keyEvery: 1 });
    const track = (await readVideoTrack(file))!;

    for (let index = 0; index < track.count; index += 1) {
      const at = track.offsets[index]!;
      const bytes = new Uint8Array(await file.slice(at, at + track.sizes[index]!).arrayBuffer());
      expect(bytes).toHaveLength([100, 200, 300][index]!);
      expect(bytes[0]).toBe(0xaa);
    }
  });

  it('reports an upright picture as upright', async () => {
    // `Mp4Writer` writes the identity matrix, which is a phone holding the camera the way
    // the sensor is mounted. The rotated cases are what a phone actually writes, and are
    // covered against real recordings rather than against a file we made ourselves.
    expect((await readVideoTrack(videoWeighing([100, 200], { keyEvery: 1 })))?.rotation).toBe(0);
  });

  it('returns nothing rather than guessing, on a file it cannot read', async () => {
    expect(await readVideoTrack(new Blob([new Uint8Array(64)]))).toBe(null);
    expect(await readVideoTrack(buildAudioOnly())).toBe(null);
  });
});

describe('readVideoWeights', () => {
  /*
    The curve someone aims a keyframe at.

    An inter-coded frame is a description of what changed since the last one, so its length
    in bytes is a measure of how much moved. Read straight out of the sample table, it costs
    the same few hundred kilobytes the audio index does and touches no picture data at all —
    which is the whole point, because the alternative on a phone is six hundred seeks
    through a multi-gigabyte file.
  */
  it('reads a frame’s weight and when it is shown', async () => {
    const sizes = [9000, 120, 130, 4000, 4200, 90];
    const weights = await readVideoWeights(videoWeighing(sizes, { keyEvery: 3 }));

    expect(Array.from(weights?.sizes ?? [])).toEqual(sizes);
    expect(weights?.hopUs).toBe(40_000);
    expect(Array.from(weights?.times ?? [])).toEqual([0, 40_000, 80_000, 120_000, 160_000, 200_000]);
    // The keyframes are the ones a caller has to bridge: a whole picture says nothing
    // about change.
    expect(Array.from(weights?.sync ?? [])).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('says every frame is a keyframe when the track has no `stss`', async () => {
    // Which is what an all-intra track is, and the caller has to know the curve it is
    // holding measures each picture rather than the difference between two.
    const weights = await readVideoWeights(videoWeighing([100, 200, 300], { keyEvery: 1 }));
    expect(Array.from(weights?.sync ?? [])).toEqual([1, 1, 1]);
  });

  it('returns nothing rather than guessing, on a file it cannot read', async () => {
    expect(await readVideoWeights(new Blob([new Uint8Array(64)]))).toBe(null);
    expect(await readVideoWeights(buildAudioOnly())).toBe(null);
  });
});

/** A video track whose frames have the given sizes, at a steady 25fps. */
function videoWeighing(sizes: number[], options: { keyEvery: number }): Blob {
  const writer = new Mp4Writer();
  const track = writer.addVideoTrack({ codec: 'vp09.00.10.08', width: 64, height: 64 });
  for (const [index, size] of sizes.entries()) {
    writer.addSample(track, {
      data: new Uint8Array(size).fill(0xaa),
      timestampUs: index * 40_000,
      durationUs: 40_000,
      key: index % options.keyEvery === 0,
    });
  }
  return writer.finalize().blob;
}

/** A file with a sound track and no picture. */
function buildAudioOnly(): Blob {
  const writer = new Mp4Writer();
  const audio = writer.addAudioTrack({ codec: 'mp4a.40.2', sampleRate: SAMPLE_RATE, channels: 2 });
  for (let i = 0; i < 4; i += 1) {
    writer.addSample(audio, { data: audioFrame(i), timestampUs: timestampFor(i), durationUs: 21_333 });
  }
  return writer.finalize().blob;
}
