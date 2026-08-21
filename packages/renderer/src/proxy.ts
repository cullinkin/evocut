import { microsToSeconds, secondsToMicros } from '@evocut/edl';
import type { FrameSize } from './compose.js';
import {
  readAudioTrack,
  readVideoTrack,
  type AudioSampleRef,
  type SourceAudioTrack,
  type SourceVideoTrack,
} from './demux.js';
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
import { Mp4Stream, type Mp4Sample, type Mp4Sink } from './mp4.js';

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
  /**
   * Pictures the decoder produced that could not be placed.
   *
   * A frame whose presentation time is not after the last one's is not a frame of the
   * recording — a repeat the element presented twice, or a sample table that disagrees with
   * itself. Counted rather than silently dropped, because "the proxy is short" and "the
   * proxy is wrong" look identical from outside and want different fixes.
   */
  framesSkipped: number;
  byteLength: number;
  videoCodec: string;
  /** `copied` when the original's audio was passed through untouched. */
  audio: 'copied' | 'none';
  /**
   * Which way the frames arrived.
   *
   * Worth recording, because it is the difference between a proxy that takes five minutes
   * and one that takes thirty, and it is decided by what the container and the browser
   * turn out to support rather than by anything visible from here.
   */
  from: 'decoder' | 'playback';
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

/** Picture frames read in one slice. Larger than the audio's: the frames are much bigger. */
const SAMPLE_BATCH = 64;

/**
 * How far the decoder may run ahead.
 *
 * Both bounds are about memory rather than speed. A decoded 4K frame is several megabytes,
 * and a decoder given a whole file and no backpressure will happily produce a hundred of
 * them — which on a phone is the tab.
 */
const MAX_DECODE_QUEUE = 8;
const MAX_HELD_FRAMES = 4;

export function isProxySupported(): boolean {
  return (
    typeof globalThis.VideoEncoder === 'function' &&
    typeof globalThis.VideoFrame === 'function' &&
    typeof globalThis.OffscreenCanvas !== 'undefined' &&
    typeof HTMLVideoElement !== 'undefined' &&
    // Only the fallback needs a frame callback, but a browser without one and without
    // `VideoDecoder` has no way to make a proxy at all, and offering is worse than not.
    (typeof globalThis.VideoDecoder === 'function' ||
      typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function')
  );
}

export async function renderProxy(
  request: ProxyRequest,
  onProgress?: (progress: ProxyProgress) => void,
): Promise<ProxyResult> {
  const warnings: string[] = [];
  let framesEncoded = 0;
  let framesSkipped = 0;
  let bytesWritten = 0;
  const report = (stage: ProxyProgress['stage'], progress: number) =>
    onProgress?.({ stage, progress, framesEncoded, byteLength: bytesWritten });

  report('preparing', 0);
  throwIfAborted(request.signal);

  /*
    Which way the frames will come.

    Straight out of a `VideoDecoder` where the container can be read and the codec is
    supported, because that runs as fast as the hardware allows rather than at the speed a
    screen would show the picture — several times quicker on a phone, which for a
    half-hour recording is the difference between five minutes and thirty. A `<video>`
    element is the fallback, and it is what WebM and anything else unindexable gets.
  */
  const decodable = await openDecodable(request.file);
  const video = decodable ? null : await openVideo(request.url);

  try {
    const durationUs = decodable ? decodable.track.durationUs : secondsToMicros(video!.duration);
    const display = decodable ? displaySize(decodable.track) : { width: video!.videoWidth, height: video!.videoHeight };
    const out = fitWithin(display, request.maxDimension ?? PROXY_MAX_DIMENSION);

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
    const pending: Mp4Sample[] = [];

    const encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        const description = metadata?.decoderConfig?.description;
        if (description && !described) {
          file.describeTrack(videoTrack, toBytes(description));
          described = true;
        }
        pending.push(chunkToSample(chunk));
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
    let lastAt = -1;
    let keyAt = -Infinity;

    /** Drain whatever the encoder has finished, and the sound that belongs beside it. */
    const drain = async (upToUs: number): Promise<void> => {
      while (pending.length > 0) {
        await file.writeSample(videoTrack, pending.shift()!);
        framesEncoded += 1;
      }
      if (sound && audioTrack !== null) {
        for (const frame of await sound.upTo(upToUs)) await file.writeSample(audioTrack, frame);
      }
      bytesWritten = file.byteLength;
    };

    /**
     * One picture becomes one frame of the proxy.
     *
     * Both strategies come through here, so the rotation, the keyframe rhythm and the
     * "timestamps only go forward" rule are stated once and cannot drift apart.
     */
    const emit = async (source: CanvasImageSource, at: number): Promise<boolean> => {
      if (at <= lastAt) {
        framesSkipped += 1;
        return false;
      }
      lastAt = at;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (decodable) applyRotation(ctx, decodable.track.rotation, out);
      const sideways = decodable ? decodable.track.rotation % 180 !== 0 : false;
      ctx.drawImage(source, 0, 0, sideways ? out.height : out.width, sideways ? out.width : out.height);

      const key = at - keyAt >= KEYFRAME_SECONDS * 1_000_000;
      if (key) keyAt = at;

      const frame = new VideoFrame(canvas, { timestamp: at });
      try {
        encoder.encode(frame, { keyFrame: key });
      } finally {
        frame.close();
      }
      await drain(at);
      report('encoding', durationUs > 0 ? Math.min(1, at / durationUs) : 0);
      return true;
    };

    report('encoding', 0);
    if (decodable) {
      await pumpByDecoding(decodable, request, emit, () => encodeError);
    } else {
      await pumpByPlayback(video!, request, emit, () => encodeError, warnings);
    }

    report('finishing', 1);
    await encoder.flush();
    if (encodeError) throw encodeError;
    encoder.close();
    await drain(Number.MAX_SAFE_INTEGER);

    const done = await file.finish();
    bytesWritten = done.byteLength;
    report('done', 1);

    return {
      durationUs: done.durationUs,
      width: out.width,
      height: out.height,
      framesEncoded,
      framesSkipped,
      byteLength: done.byteLength,
      videoCodec: codec,
      audio: audioTrack === null ? 'none' : 'copied',
      from: decodable ? 'decoder' : 'playback',
      warnings,
    };
  } finally {
    decodable?.decoder.close();
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
    }
  }
}

interface Decodable {
  track: SourceVideoTrack;
  decoder: VideoDecoder;
  frames: VideoFrame[];
  failure: Error | null;
}

/**
 * A decoder configured for this recording, or null to fall back to playing it.
 *
 * Null covers a great deal of ordinary reality — WebM, a fragmented MP4, a codec this
 * browser will not decode through WebCodecs even though it will play it — and none of it
 * is an error. The slow path still works; it is only slow.
 */
async function openDecodable(file: Blob): Promise<Decodable | null> {
  const ready = await decoderFor(file);
  if (!ready) return null;

  const { track, config } = ready;
  const state: Decodable = { track, decoder: null as unknown as VideoDecoder, frames: [], failure: null };
  state.decoder = new VideoDecoder({
    output: (frame) => state.frames.push(frame),
    error: (error) => {
      state.failure = error;
    },
  });
  try {
    state.decoder.configure(config);
  } catch {
    state.decoder.close();
    return null;
  }
  return state;
}

/**
 * Whether this recording can be read and decoded without playing it.
 *
 * Shared, so the estimate a person is shown before they commit to waiting is produced by
 * exactly the check that will decide what happens.
 */
async function decoderFor(
  file: Blob,
): Promise<{ track: SourceVideoTrack; config: VideoDecoderConfig } | null> {
  if (typeof VideoDecoder !== 'function') return null;

  const track = await readVideoTrack(file).catch(() => null);
  if (!track || track.samples.length === 0) return null;

  const config: VideoDecoderConfig = {
    codec: track.codec,
    codedWidth: track.codedWidth,
    codedHeight: track.codedHeight,
    ...(track.description ? { description: track.description as unknown as BufferSource } : {}),
    optimizeForLatency: false,
  };
  const supported = await VideoDecoder.isConfigSupported(config).catch(() => null);
  return supported?.supported ? { track, config } : null;
}

/** How the frames would come, if a proxy were made now. */
export async function proxyStrategy(file: Blob): Promise<'decoder' | 'playback'> {
  return (await decoderFor(file)) ? 'decoder' : 'playback';
}

/**
 * Feed the decoder the file, as fast as it will take it.
 *
 * The two queues are what keep this inside a phone's memory: the decoder is not allowed to
 * run far ahead of the encoder, and decoded frames — which at 4K are megabytes each — are
 * drawn and closed the moment they arrive rather than piling up.
 */
async function pumpByDecoding(
  state: Decodable,
  request: ProxyRequest,
  emit: (source: CanvasImageSource, at: number) => Promise<boolean>,
  encodeError: () => Error | null,
): Promise<void> {
  const { track, decoder } = state;

  const take = async (): Promise<void> => {
    while (state.frames.length > 0) {
      const frame = state.frames.shift()!;
      try {
        await emit(frame, frame.timestamp);
      } finally {
        frame.close();
      }
    }
  };

  for (let at = 0; at < track.samples.length; at += SAMPLE_BATCH) {
    throwIfAborted(request.signal);
    const error = encodeError() ?? state.failure;
    if (error) throw error;

    const batch = track.samples.slice(at, at + SAMPLE_BATCH);
    const from = Math.min(...batch.map((sample) => sample.offset));
    const to = Math.max(...batch.map((sample) => sample.offset + sample.size));
    const bytes = new Uint8Array(await request.file.slice(from, to).arrayBuffer());

    for (const sample of batch) {
      decoder.decode(
        new EncodedVideoChunk({
          type: sample.key ? 'key' : 'delta',
          timestamp: sample.timestampUs,
          duration: sample.durationUs,
          data: bytes.subarray(sample.offset - from, sample.offset - from + sample.size),
        }),
      );

      await take();
      while (decoder.decodeQueueSize > MAX_DECODE_QUEUE || state.frames.length > MAX_HELD_FRAMES) {
        throwIfAborted(request.signal);
        await tick();
        await take();
      }
    }
  }

  await decoder.flush();
  await take();
  if (state.failure) throw state.failure;
}

/**
 * Play the recording and take whatever the element presents.
 *
 * The old way, kept for everything the decoder path cannot open. It runs at playback speed
 * by construction — presentation is locked to the display — and a frame the element skips
 * is a frame the proxy does not have, which is why timestamps come from the picture rather
 * than from a counter.
 */
async function pumpByPlayback(
  video: HTMLVideoElement,
  request: ProxyRequest,
  emit: (source: CanvasImageSource, at: number) => Promise<boolean>,
  encodeError: () => Error | null,
  warnings: string[],
): Promise<void> {
  video.playbackRate = 1;
  video.muted = true;
  await video.play().catch(() => {
    warnings.push('The browser would not start playback, so the proxy may be short.');
  });

  for (;;) {
    throwIfAborted(request.signal);
    const error = encodeError();
    if (error) throw error;

    const presented = await nextPresentedFrame(video, FRAME_TIMEOUT_MS);
    if (presented === null) break;

    await emit(video, secondsToMicros(presented));
    if (video.ended) break;
  }

  video.pause();
}

/** Turn the canvas so the picture comes out the way up the recording is meant to be seen. */
function applyRotation(ctx: OffscreenCanvasRenderingContext2D, rotation: number, out: FrameSize): void {
  if (rotation === 90) {
    ctx.translate(out.width, 0);
    ctx.rotate(Math.PI / 2);
  } else if (rotation === 180) {
    ctx.translate(out.width, out.height);
    ctx.rotate(Math.PI);
  } else if (rotation === 270) {
    ctx.translate(0, out.height);
    ctx.rotate(-Math.PI / 2);
  }
}

/** The size the recording is meant to be seen at, which is not the size it is stored at. */
export function displaySize(track: SourceVideoTrack): FrameSize {
  return track.rotation % 180 === 0
    ? { width: track.codedWidth, height: track.codedHeight }
    : { width: track.codedHeight, height: track.codedWidth };
}

function fitWithin(size: FrameSize, maxDimension: number): FrameSize {
  const longest = Math.max(size.width, size.height);
  const scale = longest > maxDimension ? maxDimension / longest : 1;
  return { width: even(size.width * scale), height: even(size.height * scale) };
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

/**
 * Roughly how long a proxy will take.
 *
 * Two answers, because there are two ways to make one. Fed through a decoder it runs at
 * whatever the hardware manages — call it four times real time, which is conservative for a
 * phone; played through a media element it runs at exactly real time, because presentation
 * is locked to the display.
 *
 * Deliberately pessimistic. "About ten minutes" that turns out to be six is a good
 * surprise; the other way round is someone waiting on a progress bar that lied to them.
 */
export const DECODER_SPEEDUP = 4;

export function proxyEstimateMs(durationUs: number, from: 'decoder' | 'playback' = 'playback'): number {
  const seconds = microsToSeconds(durationUs);
  return Math.round((seconds * 1000) / (from === 'decoder' ? DECODER_SPEEDUP : 1));
}
