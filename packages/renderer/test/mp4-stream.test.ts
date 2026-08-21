import { describe, expect, it } from 'vitest';
import { Mp4Stream, type Mp4Sink } from '../src/mp4.js';
import { readAudioTrack, readVideoFrameRate } from '../src/demux.js';

/**
 * A file written as it is made.
 *
 * The export can hold itself in memory: a finished cut is a couple of minutes and the bytes
 * are wanted as a `Blob` anyway. A **proxy** cannot. It covers the whole recording — half an
 * hour, in the session this was built for — which at a proxy's bitrate is several hundred
 * megabytes, and holding that on a phone while a 4K decoder and an encoder are both running
 * is how a tab gets killed.
 *
 * So the bytes go to storage as they are encoded and only the index stays in memory. What
 * has to be true is that the result is still a file: the same demuxer that reads an iPhone
 * recording has to read this one, find its index at the end, and agree about every sample.
 */

/** A sink that keeps what it is given, so a test can read the file back. */
function memorySink() {
  let bytes = new Uint8Array(0);
  const sink: Mp4Sink = {
    async write(part) {
      const next = new Uint8Array(bytes.length + part.length);
      next.set(bytes);
      next.set(part, bytes.length);
      bytes = next;
    },
    async patch(position, part) {
      bytes.set(part, position);
    },
  };
  return { sink, blob: () => new Blob([bytes], { type: 'video/mp4' }), size: () => bytes.length };
}

const FRAME_US = Math.round(1_000_000 / 30);
const AUDIO_RATE = 48_000;
/** One AAC frame is 1024 samples, which at 48kHz is this long. */
const AUDIO_FRAME_US = Math.round((1024 * 1_000_000) / AUDIO_RATE);

async function write(frames: number, options: { audio?: boolean } = {}) {
  const held = memorySink();
  const file = await Mp4Stream.open(held.sink);

  const video = file.addVideoTrack({ codec: 'vp09.00.10.08', width: 64, height: 36 });
  const audio = options.audio
    ? file.addAudioTrack({ codec: 'mp4a.40.2', sampleRate: AUDIO_RATE, channels: 2 })
    : null;

  let audioAt = 0;
  for (let index = 0; index < frames; index += 1) {
    const at = index * FRAME_US;
    await file.writeSample(video, {
      data: new Uint8Array(200 + index).fill(index % 251),
      timestampUs: at,
      durationUs: FRAME_US,
      key: index % 30 === 0,
    });
    // Interleaved, as the proxy writes it: a player reading forward has the sound for the
    // picture it has just decoded.
    while (audio !== null && audioAt <= at) {
      await file.writeSample(audio, { data: new Uint8Array(96).fill(7), timestampUs: audioAt, durationUs: AUDIO_FRAME_US });
      audioAt += AUDIO_FRAME_US;
    }
  }

  const done = await file.finish();
  return { ...held, done, frames: file.sampleCount(video) };
}

describe('writing an MP4 without holding it', () => {
  it('produces a file the demuxer reads', async () => {
    const { blob, done } = await write(90, { audio: true });

    expect(done.durationUs).toBeCloseTo(90 * FRAME_US, -3);
    const rate = (await readVideoFrameRate(blob()))!;
    expect(rate.frameRate.num / rate.frameRate.den).toBeCloseTo(30, 1);

    const track = await readAudioTrack(blob());
    expect(track?.codec).toBe('mp4a.40.2');
    expect(track?.sampleRate).toBe(AUDIO_RATE);
    expect(track?.channels).toBe(2);
  });

  it('reads back the exact bytes each offset points at', async () => {
    /*
      The whole mechanism in one assertion. The index is built from offsets recorded as the
      bytes went past, rather than computed at the end from data still in hand — so a
      mistake in the bookkeeping shows up here as the wrong bytes at the stated place.
    */
    const { blob } = await write(60, { audio: true });
    const track = (await readAudioTrack(blob()))!;
    const file = blob();

    expect(track.samples.length).toBeGreaterThan(50);
    for (const at of [0, 7, track.samples.length - 1]) {
      const ref = track.samples[at]!;
      const bytes = new Uint8Array(await file.slice(ref.offset, ref.offset + ref.size).arrayBuffer());
      expect(ref.size).toBe(96);
      expect([...bytes]).toEqual(new Array(96).fill(7));
    }
  });

  it('interleaves, so a player reading forward has the sound for the picture', async () => {
    const { blob } = await write(90, { audio: true });
    const track = (await readAudioTrack(blob()))!;
    // Audio frames are spread through the file rather than piled at one end: the last one
    // starts a long way past the first, in bytes as well as in time.
    const first = track.samples[0]!.offset;
    const last = track.samples.at(-1)!.offset;
    expect(last - first).toBeGreaterThan(20_000);
    expect(track.samples.every((sample, index) => index === 0 || sample.offset > track.samples[index - 1]!.offset)).toBe(true);
  });

  it('writes a 64-bit `mdat`, so a proxy may be larger than 4GB', async () => {
    const { blob } = await write(4);
    const head = new DataView(await blob().slice(0, 64).arrayBuffer());
    // `ftyp` first, then an `mdat` whose 32-bit size field is the escape value 1.
    const ftypSize = head.getUint32(0);
    expect(head.getUint32(ftypSize)).toBe(1);
    expect(String.fromCharCode(...new Uint8Array(await blob().slice(ftypSize + 4, ftypSize + 8).arrayBuffer()))).toBe('mdat');
    // And the length was patched: it covers the header plus everything written after it.
    expect(Number(head.getBigUint64(ftypSize + 8))).toBeGreaterThan(16);
  });

  it('refuses to write a file with nothing in it', async () => {
    const held = memorySink();
    const file = await Mp4Stream.open(held.sink);
    file.addVideoTrack({ codec: 'vp09.00.10.08', width: 8, height: 8 });
    await expect(file.finish()).rejects.toThrow(/no samples/i);
  });
});
