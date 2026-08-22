import { describe, expect, it } from 'vitest';
import { Mp4Writer, audioSpecificConfig } from '../src/mp4.js';

/**
 * The muxer is tested by reading its output back.
 *
 * Asserting on the bytes it emits would only restate the code. What matters is that a
 * player walking the file finds what the tables promise — above all that `stco` offsets
 * land on the sample they claim to, since those are computed in a second pass over a box
 * whose size depends on them, and an off-by-anything there produces a file that opens,
 * reports the right duration, and plays garbage.
 */

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf']);

interface Box {
  type: string;
  start: number;
  end: number;
  /** Payload, after the 8-byte header. */
  body: Uint8Array;
  children: Box[];
}

function parseBoxes(bytes: Uint8Array, start = 0, end = bytes.length): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes: Box[] = [];
  let at = start;

  while (at + 8 <= end) {
    const size = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (size < 8 || at + size > end) throw new Error(`Bad box ${type} of size ${size} at ${at}`);
    boxes.push({
      type,
      start: at,
      end: at + size,
      body: bytes.subarray(at + 8, at + size),
      children: CONTAINERS.has(type) ? parseBoxes(bytes, at + 8, at + size) : [],
    });
    at += size;
  }

  return boxes;
}

function find(boxes: Box[], path: string): Box {
  const [head, ...rest] = path.split('/');
  const box = boxes.find((candidate) => candidate.type === head);
  if (!box) throw new Error(`No ${head} among ${boxes.map((b) => b.type).join(', ')}`);
  return rest.length === 0 ? box : find(box.children, rest.join('/'));
}

/** `stsd` and its sample entries are not uniform containers, so they are scanned by hand. */
function findNested(bytes: Uint8Array, type: string): number {
  const needle = [...type].map((c) => c.charCodeAt(0));
  for (let at = 0; at + 4 <= bytes.length; at += 1) {
    if (needle.every((code, i) => bytes[at + i] === code)) return at;
  }
  return -1;
}

function u32At(bytes: Uint8Array, at: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at);
}

/** Sample data that is recognisable when found again: byte n of sample k is k. */
function sample(id: number, length: number) {
  return new Uint8Array(length).fill(id);
}

const AVCC = new Uint8Array([1, 0x42, 0, 0x1f, 0xff, 0xe0, 0, 4, 0x67, 0, 0, 0, 1, 0, 4, 0x68, 0, 0, 0]);

async function writeVideo(count = 4) {
  const writer = new Mp4Writer();
  const track = writer.addVideoTrack({ codec: 'avc1.42E01F', description: AVCC, width: 1080, height: 1920 });
  for (let index = 0; index < count; index += 1) {
    writer.addSample(track, {
      data: sample(index + 1, 100 + index),
      timestampUs: index * 33_333,
      durationUs: 33_333,
      key: index === 0,
    });
  }
  const { blob, durationUs } = writer.finalize();
  return { bytes: new Uint8Array(await blob.arrayBuffer()), durationUs };
}

describe('Mp4Writer', () => {
  it('writes ftyp, then moov, then mdat', async () => {
    const { bytes } = await writeVideo();
    expect(parseBoxes(bytes).map((box) => box.type)).toEqual(['ftyp', 'moov', 'mdat']);
  });

  it('puts moov before the media, so the file opens without a full scan', async () => {
    const { bytes } = await writeVideo();
    const boxes = parseBoxes(bytes);
    expect(find(boxes, 'moov').end).toBe(find(boxes, 'mdat').start);
  });

  it('points every chunk offset at the sample it claims', async () => {
    const { bytes } = await writeVideo(6);
    const stbl = find(parseBoxes(bytes), 'moov/trak/mdia/minf/stbl');
    const stco = find(stbl.children, 'stco');
    const stsz = find(stbl.children, 'stsz');

    const count = u32At(stco.body, 4);
    expect(count).toBe(6);

    for (let index = 0; index < count; index += 1) {
      const offset = u32At(stco.body, 8 + index * 4);
      const size = u32At(stsz.body, 12 + index * 4);
      const found = bytes.subarray(offset, offset + size);
      // Sample k was filled with the byte k+1 — so this checks both the offset and the
      // size, and would fail loudly if the two-pass moov measurement ever drifted.
      expect(size).toBe(100 + index);
      expect([...new Set(found)]).toEqual([index + 1]);
    }
  });

  it('collapses a constant frame rate into a single stts run', async () => {
    const { bytes } = await writeVideo(30);
    const stts = find(parseBoxes(bytes), 'moov/trak/mdia/minf/stbl/stts');
    expect(u32At(stts.body, 4)).toBe(1);
    expect(u32At(stts.body, 8)).toBe(30);
    expect(u32At(stts.body, 12)).toBe(33_333);
  });

  it('writes stss only when some samples are not keyframes', async () => {
    const { bytes } = await writeVideo(4);
    const stbl = find(parseBoxes(bytes), 'moov/trak/mdia/minf/stbl');
    const stss = find(stbl.children, 'stss');
    expect(u32At(stss.body, 4)).toBe(1);
    expect(u32At(stss.body, 8)).toBe(1); // 1-based index of the only keyframe

    const writer = new Mp4Writer();
    const track = writer.addVideoTrack({ codec: 'avc1.42E01F', description: AVCC, width: 64, height: 64 });
    writer.addSample(track, { data: sample(1, 10), timestampUs: 0, durationUs: 1000, key: true });
    writer.addSample(track, { data: sample(2, 10), timestampUs: 1000, durationUs: 1000, key: true });
    const all = new Uint8Array(await writer.finalize().blob.arrayBuffer());
    const table = find(parseBoxes(all), 'moov/trak/mdia/minf/stbl');
    expect(table.children.map((box) => box.type)).not.toContain('stss');
  });

  it('reports the duration of the longest track', async () => {
    const { durationUs } = await writeVideo(3);
    // Three frames at 33333us: the last one's declared duration is what ends the file.
    expect(durationUs).toBe(99_999);
  });

  it('interleaves the tracks by presentation time', async () => {
    const writer = new Mp4Writer();
    const video = writer.addVideoTrack({ codec: 'avc1.42E01F', description: AVCC, width: 64, height: 64 });
    const audio = writer.addAudioTrack({ codec: 'mp4a.40.2', sampleRate: 48_000, channels: 2 });

    // Video every 100ms, audio every 50ms, added track by track — the writer has to put
    // them back in time order or a player has to seek backwards to find its audio.
    for (let index = 0; index < 4; index += 1) {
      writer.addSample(video, { data: sample(10 + index, 8), timestampUs: index * 100_000, key: true });
    }
    for (let index = 0; index < 8; index += 1) {
      writer.addSample(audio, { data: sample(100 + index, 4), timestampUs: index * 50_000, key: true });
    }

    const bytes = new Uint8Array(await writer.finalize().blob.arrayBuffer());
    const traks = find(parseBoxes(bytes), 'moov').children.filter((box) => box.type === 'trak');
    const offsetsFor = (trak: Box) => {
      const stco = find(trak.children, 'mdia/minf/stbl/stco');
      return Array.from({ length: u32At(stco.body, 4) }, (_, i) => u32At(stco.body, 8 + i * 4));
    };

    const videoOffsets = offsetsFor(traks[0]!);
    const audioOffsets = offsetsFor(traks[1]!);
    // First audio sample shares its timestamp with the first video sample and is written
    // right after it; the second audio sample (50ms) precedes the second video (100ms).
    expect(audioOffsets[0]).toBeGreaterThan(videoOffsets[0]!);
    expect(audioOffsets[1]).toBeLessThan(videoOffsets[1]!);
  });

  it('describes AAC in an esds the decoder can read', async () => {
    const writer = new Mp4Writer();
    const audio = writer.addAudioTrack({ codec: 'mp4a.40.2', sampleRate: 48_000, channels: 2 });
    writer.addSample(audio, { data: sample(1, 64), timestampUs: 0, durationUs: 21_333, key: true });
    const bytes = new Uint8Array(await writer.finalize().blob.arrayBuffer());

    const stsd = find(parseBoxes(bytes), 'moov/trak/mdia/minf/stbl/stsd');
    const mp4a = findNested(stsd.body, 'mp4a');
    expect(mp4a).toBeGreaterThan(-1);
    // 16.16 fixed-point sample rate, 24 bytes into the sample entry payload.
    expect(u32At(stsd.body, mp4a + 4 + 24) >>> 16).toBe(48_000);

    const esds = findNested(stsd.body, 'esds');
    expect(esds).toBeGreaterThan(-1);
    const asc = audioSpecificConfig(48_000, 2);
    const tail = stsd.body.subarray(esds);
    expect(findNested(tail, String.fromCharCode(...asc))).toBeGreaterThan(-1);
  });

  it('encodes the AudioSpecificConfig the way every AAC decoder expects', () => {
    // 48kHz stereo AAC-LC is 0x11 0x90 — the canonical value, so a typo in the bit
    // packing shows up here rather than as silence on a phone.
    expect([...audioSpecificConfig(48_000, 2)]).toEqual([0x11, 0x90]);
    expect([...audioSpecificConfig(44_100, 1)]).toEqual([0x12, 0x08]);
    expect(() => audioSpecificConfig(37_000, 2)).toThrow(/sample rate/);
  });

  it('derives the VP9 configuration record from the codec string', async () => {
    const writer = new Mp4Writer();
    const video = writer.addVideoTrack({ codec: 'vp09.02.41.10', width: 64, height: 64 });
    writer.addSample(video, { data: sample(1, 16), timestampUs: 0, durationUs: 33_333, key: true });
    const bytes = new Uint8Array(await writer.finalize().blob.arrayBuffer());

    const stsd = find(parseBoxes(bytes), 'moov/trak/mdia/minf/stbl/stsd');
    expect(findNested(stsd.body, 'vp09')).toBeGreaterThan(-1);

    const vpcC = findNested(stsd.body, 'vpcC');
    expect(vpcC).toBeGreaterThan(-1);
    // Past the type and the version/flags word: profile 2, level 41, then 10-bit depth
    // packed above 4:2:0 colocated chroma and a limited range flag.
    const payload = stsd.body.subarray(vpcC + 8);
    expect(payload[0]).toBe(2);
    expect(payload[1]).toBe(41);
    expect(payload[2]).toBe((10 << 4) | (1 << 1));
  });

  it('rewrites OpusHead into a dOps, byte order and all', async () => {
    // A real OpusHead from a browser encoder: version 1, stereo, 312 pre-skip, 48kHz,
    // all of it little-endian.
    const head = new Uint8Array([
      ...[0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64],
      1, 2, 0x38, 0x01, 0x80, 0xbb, 0x00, 0x00, 0, 0, 0,
    ]);
    const writer = new Mp4Writer();
    const audio = writer.addAudioTrack({
      codec: 'opus',
      description: head,
      sampleRate: 48_000,
      channels: 2,
    });
    writer.addSample(audio, { data: sample(1, 32), timestampUs: 0, durationUs: 20_000, key: true });
    const bytes = new Uint8Array(await writer.finalize().blob.arrayBuffer());

    const stsd = find(parseBoxes(bytes), 'moov/trak/mdia/minf/stbl/stsd');
    expect(findNested(stsd.body, 'Opus')).toBeGreaterThan(-1);

    const dOps = findNested(stsd.body, 'dOps');
    const payload = stsd.body.subarray(dOps + 4);
    expect(payload[0]).toBe(0); // version 0 here, whatever OpusHead said
    expect(payload[1]).toBe(2); // channels
    expect((payload[2]! << 8) | payload[3]!).toBe(312); // pre-skip, now big-endian
    expect(u32At(payload, 4)).toBe(48_000);
  });

  it('will not write a track it cannot describe', () => {
    /*
      Checked when the index is built rather than when the track is declared.

      An AVC encoder does not hand back its `avcC` until the first chunk, so a writer that
      streams — and must declare its tracks before anything is encoded — cannot have it at
      declaration time. Refusing there made a proxy fail instantly on every phone that
      encodes H.264, with an error blaming the encoder for withholding something it had not
      been asked for. The rule that actually matters is about the file: a track with no
      decoder configuration in `moov` is a track nothing can play.
    */
    const writer = new Mp4Writer();
    const video = writer.addVideoTrack({ codec: 'avc1.42E01F', width: 64, height: 64 });
    writer.addSample(video, { data: new Uint8Array(32), timestampUs: 0, durationUs: 33_333, key: true });
    expect(() => writer.finalize()).toThrow(/avcC/);

    const sound = new Mp4Writer();
    const audio = sound.addAudioTrack({ codec: 'opus', sampleRate: 48_000, channels: 2 });
    sound.addSample(audio, { data: new Uint8Array(16), timestampUs: 0, durationUs: 20_000 });
    expect(() => sound.finalize()).toThrow(/OpusHead/);
  });

  it('refuses to write a file with no samples', () => {
    const writer = new Mp4Writer();
    writer.addVideoTrack({ codec: 'avc1.42E01F', description: AVCC, width: 64, height: 64 });
    expect(writer.hasSamples).toBe(false);
    expect(() => writer.finalize()).toThrow(/no samples/i);
  });
});
