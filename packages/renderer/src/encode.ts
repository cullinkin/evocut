import { microsToSeconds } from '@evocut/edl';
import type { FrameSize } from './compose.js';
import type { Mp4Sample } from './mp4.js';

/**
 * The parts of encoding that are not about any one job.
 *
 * Pulled out of `render.ts` when a second thing needed them. The export renders an *edit* —
 * compositing, colour, framing, a frame counter that guarantees constant output timing —
 * and a proxy renders a *recording*, flat, at whatever times the source presents. Almost
 * none of the export applies to that, but all of this does: how to pick a codec a phone
 * will actually accept, how to wait for the next presented frame, how to turn an encoded
 * chunk into a sample. One copy, so a fix to either job fixes both.
 */

/**
 * Codecs to try, best first.
 *
 * AVC and AAC lead because the export's destination is an iPhone's camera roll, and that
 * is what it accepts. VP9 follows so that a browser without the licensed pair still
 * produces a file — including the Chromium the end-to-end checks run in, which is the only
 * way any of this gets exercised outside a phone.
 */
export const VIDEO_CODECS = ['avc1', 'vp09.00.41.08', 'vp09.00.10.08'] as const;

export const SEEK_TIMEOUT_MS = 5000;
/** A presented frame should arrive within a frame or two; this is generous by design. */
export const FRAME_TIMEOUT_MS = 2000;
/** How many frames may be in flight before capture waits for the encoder. */
export const MAX_ENCODE_QUEUE = 8;

export async function pickVideoCodec(out: FrameSize): Promise<string | null> {
  for (const candidate of VIDEO_CODECS) {
    const codec = candidate === 'avc1' ? avcCodecString(out) : candidate;
    const config: VideoEncoderConfig = {
      codec,
      width: out.width,
      height: out.height,
      bitrate: bitrateFor(out),
      ...(codec.startsWith('avc') ? { avc: { format: 'avc' as const } } : {}),
    };
    const supported = await VideoEncoder.isConfigSupported(config).catch(() => null);
    if (supported?.supported) return codec;
  }
  return null;
}

/**
 * Constrained baseline AVC at a level that covers the output size.
 *
 * Constrained baseline (`42E0…`) rather than main or high, because it forbids B-frames —
 * and this project's muxer writes no `ctts` table, so a stream whose presentation order
 * differed from its decode order would play back with its frames shuffled. Declaring too
 * low a level is the other way to get a file a decoder refuses, hence the size ladder.
 */
export function avcCodecString(out: FrameSize): string {
  const pixels = out.width * out.height;
  const level = pixels <= 921_600 ? 0x1f : pixels <= 2_073_600 ? 0x29 : pixels <= 8_912_896 ? 0x33 : 0x3e;
  return `avc1.42E0${level.toString(16).toUpperCase().padStart(2, '0')}`;
}

/** Roughly 0.1 bits per pixel per frame at 30fps, floored at something watchable. */
export function bitrateFor(out: FrameSize): number {
  return Math.max(2_000_000, Math.round(out.width * out.height * 0.1 * 30));
}

export function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/** The next presented frame's position in the source, in seconds. Null if none arrived. */
export function nextPresentedFrame(video: HTMLVideoElement, timeoutMs: number): Promise<number | null> {
  const request = video.requestVideoFrameCallback?.bind(video);
  if (!request) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    const handle = request((_now, metadata) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(metadata.mediaTime);
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      video.cancelVideoFrameCallback?.(handle);
      resolve(null);
    }, timeoutMs);
  });
}

export async function seekTo(video: HTMLVideoElement, sourceUs: number): Promise<void> {
  const target = Math.max(0, microsToSeconds(sourceUs));
  if (Math.abs(video.currentTime - target) < 1e-4) return;
  video.currentTime = target;
  await onceEvent(video, 'seeked', SEEK_TIMEOUT_MS).catch(() => {
    // A seek that never reports back is not fatal: the next frame drawn is simply
    // whatever the element is showing, and the output frame still lands on the grid.
  });
}

export function onceEvent(target: HTMLVideoElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error(`The video reported an error while waiting for ${event}.`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${event}.`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(event, done);
      target.removeEventListener('error', failed);
    };

    target.addEventListener(event, done, { once: true });
    target.addEventListener('error', failed, { once: true });
  });
}

/** Yield to the event loop so the encoder can drain and the UI can paint. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 4));
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('The export was cancelled.');
  error.name = 'AbortError';
  throw error;
}

export function chunkToSample(chunk: EncodedVideoChunk | EncodedAudioChunk): Mp4Sample {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  return {
    data,
    timestampUs: chunk.timestamp,
    ...(chunk.duration === null ? {} : { durationUs: chunk.duration }),
    key: chunk.type === 'key',
  };
}

/** A private copy of a codec description: the encoder may reuse the buffer it handed us. */
export function toBytes(source: AllowSharedBufferSource): Uint8Array {
  const view = ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);
  return new Uint8Array(view);
}

