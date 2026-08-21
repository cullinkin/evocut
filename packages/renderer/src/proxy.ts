import { microsToSeconds, secondsToMicros } from '@evocut/edl';
import type { FrameSize } from './compose.js';
import { readAudioTrack, type AudioSampleRef, type SourceAudioTrack } from './demux.js';
import {
  FRAME_TIMEOUT_MS,
  MAX_ENCODE_QUEUE,
  bitrateFor,
  chunkToSample,
  even,
  nextPresentedFrame,
  onceEvent,
  pickVideoCodec,
  throwIfAborted,
  tick,
  toBytes,
} from './encode.js';
import { Mp4Stream, type Mp4Sink } from './mp4.js';

/**
 * A small copy of a recording, to edit against.
 *
 * ## Why
 *
 * Everything the editor does to the picture — scrub, play, cut, extract a filmstrip — it
 * does by seeking a `<video>` element. Against a 4K HEVC recording on a phone, one seek is
 * most of a second: the file is gigabytes, the keyframes are seconds apart, and the
 * hardware decoder is already being asked for two streams by the preview. That is the
 * whole of the lag, and no amount of pacing or painting fixes it, because the cost is in
 * the decode.
 *
 * Asked for in exactly those terms: "it seems a little silly that we're trying to work
 * directly on the high resolution and huge raw source video". It is. Every editor that
 * handles this footage makes proxies, and for the same reason.
 *
 * So: transcode once, to something a phone can seek instantly — a fraction of the
 * resolution, a fraction of the bitrate, and **keyframes every second** rather than every
 * two, which is what actually makes a scrub cheap. Edit against that. Export from the
 * original, which is untouched and stays untouched.
 *
 * ## What must be true of it
 *
 * One thing, and everything else follows from it: **the proxy's clock is the recording's
 * clock.** A frame at 4:12.400 in the proxy is the frame at 4:12.400 in the original, so
 * every cut point, keyframe and trim in the EDL means the same thing against either. That
 * is why frames are timestamped with the presentation time the decoder reports rather than
 * counted off a grid: a dropped frame then costs a picture, never a place.
 *
 * ## What it costs
 *
 * About as long as the recording, because capture runs at playback speed — a decoder
 * presents frames at the rate a screen shows them, and asking for them faster gets you
 * fewer, not sooner. Twenty-seven minutes of footage is twenty-seven minutes of waiting,
 * once, ever. The sound is not re-encoded at all: the original's compressed audio frames
 * are copied through byte for byte, which costs nothing and cannot degrade.
 */

export interface ProxyRequest {
  /** The original, for its audio index. */
  file: Blob;
  /** A URL a `<video>` element can play and seek — the same one the editor uses. */
  url: string;
  /** Where the proxy goes, a piece at a time. It is far too large to hold. */
  sink: Mp4Sink;
  /** Longest edge of the proxy. */
  maxDimension?: number;
  signal?: AbortSignal;
}

export interface ProxyProgress {
  /** 0..1 through the recording. */
  progress: number;
  framesEncoded: number;
  /** Bytes written so far, so a person can see what it is costing them. */
  byteLength: number;
  stage: 'preparing' | 'encoding' | 'finishing' | 'done';
}

export interface ProxyResult {
  durationUs: number;
  width: number;
  height: number;
  framesEncoded: number;
  byteLength: number;
  videoCodec: string;
  /** `copied` when the original's audio was passed through untouched. */
  audio: 'copied' | 'none';
  warnings: string[];
}

/**
 * 1080 on the long edge.
 *
 * A phone's preview is about 1200 device pixels tall at its largest, so this is already
 * more than the screen can show — and against a 4K recording it is a twelfth of the pixels
 * to decode.
 */
export const PROXY_MAX_DIMENSION = 1080;

/**
 * A keyframe every second.
 *
 * The real reason a proxy scrubs well. A seek costs the decode of everything from the
 * previous keyframe onward, so halving the interval halves the worst seek — and at a
 * proxy's resolution the extra keyframes are cheap. Two seconds is right for a file
 * somebody watches; one is right for a file somebody scrubs.
 */
const KEYFRAME_SECONDS = 1;

/** Proxies are for looking at, not for keeping: a third of what an export would spend. */
const BITRATE_SHARE = 0.5;

/** Audio frames read from the original in one go, rather than one slice per frame. */
const AUDIO_BATCH = 256;

export function isProxySupported(): boolean {
  return (
    typeof globalThis.VideoEncoder === 'function' &&
    typeof globalThis.VideoFrame === 'function' &&
    typeof globalThis.OffscreenCanvas !== 'undefined' &&
    typeof HTMLVideoElement !== 'undefined' &&
    typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function'
  );
}

export async function renderProxy(
  request: ProxyRequest,
  onProgress?: (progress: ProxyProgress) => void,
): Promise<ProxyResult> {
  const warnings: string[] = [];
  const report = (stage: ProxyProgress['stage'], progress: number, frames: number, bytes: number) =>
    onProgress?.({ stage, progress, framesEncoded: frames, byteLength: bytes });

  report('preparing', 0, 0, 0);
  throwIfAborted(request.signal);

  const video = await openVideo(request.url);
  try {
    const durationUs = secondsToMicros(video.duration);
    const out = proxySize(video, request.maxDimension ?? PROXY_MAX_DIMENSION);

    const codec = await pickVideoCodec(out);
    if (!codec) throw new Error('This browser will not encode video, so it cannot make a proxy.');

    const canvas = new OffscreenCanvas(out.width, out.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get a 2D context to draw the proxy into.');

    const audio = await readAudioTrack(request.file).catch(() => null);
    if (!audio) {
      // Not fatal, and worth saying plainly: the proxy is what the editor plays, so a
      // silent one is a silent editor.
      warnings.push('The original’s audio track could not be read, so the proxy is silent.');
    }

    const file = await Mp4Stream.open(request.sink);
    const videoTrack = file.addVideoTrack({ codec, width: out.width, height: out.height });
    const audioTrack = audio
      ? file.addAudioTrack({
          codec: audio.codec,
          ...(audio.description ? { description: audio.description } : {}),
          sampleRate: audio.sampleRate,
          channels: audio.channels,
        })
      : null;

    let described = false;
    let encodeError: Error | null = null;
    const pending: Array<{ sample: ReturnType<typeof chunkToSample> }> = [];

    const encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        const description = metadata?.decoderConfig?.description;
        if (description && !described) {
          file.describeTrack(videoTrack, toBytes(description));
          described = true;
        }
        pending.push({ sample: chunkToSample(chunk) });
      },
      error: (error) => {
        encodeError = error;
      },
    });
    encoder.configure({
      codec,
      width: out.width,
      height: out.height,
      bitrate: Math.round(bitrateFor(out) * BITRATE_SHARE),
      latencyMode: 'quality',
      ...(codec.startsWith('avc') ? { avc: { format: 'avc' as const } } : {}),
    });

    const sound = audio ? new AudioCopier(request.file, audio) : null;
    let framesEncoded = 0;
    let lastAt = -1;
    let keyAt = -Infinity;

    /** Drain whatever the encoder has finished, and the sound that belongs beside it. */
    const flush = async (upToUs: number): Promise<void> => {
      while (pending.length > 0) {
        const next = pending.shift()!;
        await file.writeSample(videoTrack, next.sample);
        framesEncoded += 1;
      }
      if (sound && audioTrack !== null) {
        for (const frame of await sound.upTo(upToUs)) {
          await file.writeSample(audioTrack, frame);
        }
      }
    };

    video.playbackRate = 1;
    video.muted = true;
    await video.play().catch(() => {
      warnings.push('The browser would not start playback, so the proxy may be short.');
    });

    report('encoding', 0, 0, 0);

    for (;;) {
      throwIfAborted(request.signal);
      if (encodeError) throw encodeError;

      const presented = await nextPresentedFrame(video, FRAME_TIMEOUT_MS);
      if (presented === null) break;

      const at = secondsToMicros(presented);
      // An encoder requires timestamps that only go forward. A repeat means the element
      // presented the same picture twice, which is not a frame of the recording.
      if (at <= lastAt) {
        if (video.ended) break;
        continue;
      }
      lastAt = at;

      ctx.drawImage(video, 0, 0, out.width, out.height);
      const key = at - keyAt >= KEYFRAME_SECONDS * 1_000_000;
      if (key) keyAt = at;

      const frame = new VideoFrame(canvas, { timestamp: at });
      try {
        encoder.encode(frame, { keyFrame: key });
      } finally {
        frame.close();
      }

      await flush(at);
      report('encoding', durationUs > 0 ? Math.min(1, at / durationUs) : 0, framesEncoded, file.byteLength);

      /*
        Backpressure, and it is not optional. Without it a phone builds a queue of frames it
        has no memory for — the same failure the export hit, and the reason both pause the
        element rather than merely waiting.
      */
      if (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
        video.pause();
        while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE / 2) {
          throwIfAborted(request.signal);
          await tick();
        }
        await video.play().catch(() => {});
      }

      if (video.ended) break;
    }

    video.pause();
    report('finishing', 1, framesEncoded, file.byteLength);

    await encoder.flush();
    if (encodeError) throw encodeError;
    encoder.close();
    await flush(Number.MAX_SAFE_INTEGER);

    const done = await file.finish();
    report('done', 1, framesEncoded, done.byteLength);

    return {
      durationUs: done.durationUs,
      width: out.width,
      height: out.height,
      framesEncoded,
      byteLength: done.byteLength,
      videoCodec: codec,
      audio: audioTrack === null ? 'none' : 'copied',
      warnings,
    };
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
  }
}

/**
 * The original's compressed audio, copied through.
 *
 * Not decoded and re-encoded: there is nothing to gain by it and two things to lose — the
 * time, and the quality. Half an hour of AAC is about twenty-six megabytes, which is less
 * than a minute of the proxy's picture.
 *
 * Read in batches because the frames are small and contiguous: one slice per frame would
 * be seventy thousand round trips to storage for a recording of that length.
 */
export class AudioCopier {
  #next = 0;
  #batch: Array<{ data: Uint8Array; ref: AudioSampleRef }> = [];

  constructor(
    private readonly file: Blob,
    private readonly track: SourceAudioTrack,
  ) {}

  /** Every audio frame that starts at or before `us`, in order. */
  async upTo(us: number): Promise<Array<{ data: Uint8Array; timestampUs: number; durationUs: number }>> {
    const out: Array<{ data: Uint8Array; timestampUs: number; durationUs: number }> = [];
    while (this.#next < this.track.samples.length && this.track.samples[this.#next]!.timestampUs <= us) {
      if (this.#batch.length === 0) await this.#fill();
      const held = this.#batch.shift();
      if (!held) break;
      out.push({ data: held.data, timestampUs: held.ref.timestampUs, durationUs: held.ref.durationUs });
      this.#next += 1;
    }
    return out;
  }

  async #fill(): Promise<void> {
    const refs = this.track.samples.slice(this.#next, this.#next + AUDIO_BATCH);
    if (refs.length === 0) return;

    const from = Math.min(...refs.map((ref) => ref.offset));
    const to = Math.max(...refs.map((ref) => ref.offset + ref.size));
    const bytes = new Uint8Array(await this.file.slice(from, to).arrayBuffer());
    this.#batch = refs.map((ref) => ({
      ref,
      // A copy rather than a view: the batch's buffer is released once its frames are
      // written, and a view would keep the whole megabyte alive for one frame.
      data: bytes.slice(ref.offset - from, ref.offset - from + ref.size),
    }));
  }
}

async function openVideo(url: string): Promise<HTMLVideoElement> {
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  // Some iOS versions refuse to decode for a detached element, so it goes in the document
  // — just far enough off-screen to be invisible and un-tappable.
  video.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.appendChild(video);
  await onceEvent(video, 'loadedmetadata', 60_000);
  return video;
}

function proxySize(video: HTMLVideoElement, maxDimension: number): FrameSize {
  const width = video.videoWidth || 1920;
  const height = video.videoHeight || 1080;
  const longest = Math.max(width, height);
  const scale = longest > maxDimension ? maxDimension / longest : 1;
  return { width: even(width * scale), height: even(height * scale) };
}

/** How long a proxy will take, roughly: the recording's own length, because capture plays it. */
export function proxyEstimateMs(durationUs: number): number {
  return Math.round(microsToSeconds(durationUs) * 1000);
}
