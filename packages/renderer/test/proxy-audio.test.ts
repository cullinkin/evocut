import { describe, expect, it } from 'vitest';
import { AudioCopier } from '../src/proxy.js';
import { readAudioTrack } from '../src/demux.js';
import { Mp4Writer } from '../src/mp4.js';

/**
 * The proxy's sound, which is the original's sound.
 *
 * Not decoded and re-encoded: there is nothing to gain by it and two things to lose — the
 * time, and the quality. Half an hour of AAC is about twenty-six megabytes, which is less
 * than a minute of the proxy's picture. So the compressed frames are copied through byte
 * for byte, and what has to be true is exactly that: byte for byte, in order, at the times
 * the original gave them.
 *
 * Worth its own test because the browser check cannot reach it. The end-to-end fixture is a
 * WebM, whose audio index this cannot read at all — so on that path the proxy comes out
 * silent, correctly and uninterestingly, and the copying is never exercised.
 */
const RATE = 48_000;
/*
  Where a frame falls, as the container computes it — from the sample count in the track's
  own timebase, not from a microsecond figure multiplied up. The two disagree by a
  microsecond every few frames, and the container's answer is the one that matters because
  it is the one the proxy will carry.
*/
const at = (index: number) => Math.round((index * 1024 * 1_000_000) / RATE);
const FRAME_US = at(1);

/** An MP4 whose audio frames each carry their own index, so a copy can be checked. */
function recording(frames: number): Blob {
  const writer = new Mp4Writer();

  const video = writer.addVideoTrack({ codec: 'vp09.00.10.08', width: 32, height: 32 });
  for (let index = 0; index < 8; index += 1) {
    writer.addSample(video, {
      data: new Uint8Array(64).fill(0xaa),
      timestampUs: index * 33_333,
      durationUs: 33_333,
      key: index === 0,
    });
  }

  const audio = writer.addAudioTrack({ codec: 'mp4a.40.2', sampleRate: RATE, channels: 2 });
  for (let index = 0; index < frames; index += 1) {
    writer.addSample(audio, {
      data: new Uint8Array(40).fill(index % 251),
      timestampUs: at(index),
      durationUs: FRAME_US,
    });
  }
  return writer.finalize().blob;
}

describe('copying the original’s audio into the proxy', () => {
  it('hands back the frames due by a given moment, in order and unaltered', async () => {
    const file = recording(40);
    const track = (await readAudioTrack(file))!;
    const copier = new AudioCopier(file, track);

    const first = await copier.upTo(at(3));
    expect(first.map((frame) => frame.timestampUs)).toEqual([at(0), at(1), at(2), at(3)]);
    expect([...first[2]!.data]).toEqual(new Array(40).fill(2));
    expect(first[0]!.durationUs).toBe(FRAME_US);

    // Nothing is handed over twice: the picture moves forward and so does the sound.
    const next = await copier.upTo(at(5));
    expect(next.map((frame) => frame.timestampUs)).toEqual([at(4), at(5)]);
  });

  it('reads past the end of a batch without losing a frame', async () => {
    /*
      Frames are read from storage in batches of a few hundred, because one slice per frame
      would be seventy thousand round trips on a recording of any length. The seam between
      two batches is where an off-by-one would hide.
    */
    const file = recording(600);
    const track = (await readAudioTrack(file))!;
    const copier = new AudioCopier(file, track);

    const all = await copier.upTo(Number.MAX_SAFE_INTEGER);
    expect(all).toHaveLength(600);
    expect(all.every((frame, index) => frame.timestampUs === at(index))).toBe(true);
    expect([...all[300]!.data]).toEqual(new Array(40).fill(300 % 251));
    expect([...all[599]!.data]).toEqual(new Array(40).fill(599 % 251));
  });

  it('gives back nothing when nothing is due yet', async () => {
    const file = recording(10);
    const track = (await readAudioTrack(file))!;
    expect(await new AudioCopier(file, track).upTo(-1)).toEqual([]);
  });
});
