import {
  microsToSeconds,
  secondsToMicros,
  timelineDuration,
  type Clip,
  type Project,
  type Timeline,
} from '@evocut/edl';
import { clearFrame, drawLayer, type FrameSize } from './compose.js';
import { AUDIO_SAMPLE_RATE, decodeAudio, mixdown, planAudio, toPlanar, type ClipAudio } from './audio.js';
import {
  MAX_UNINDEXED_AUDIO_BYTES,
  decodeAudioWindow,
  isAudioDecodeSupported,
} from './decode-audio.js';
import { readAudioTrack } from './demux.js';
import {
  FRAME_TIMEOUT_MS,
  SEEK_TIMEOUT_MS,
  MAX_ENCODE_QUEUE,
  bitrateFor,
  chunkToSample,
  even,
  nextPresentedFrame,
  onceEvent,
  pickVideoCodec,
  seekTo,
  throwIfAborted,
  tick,
  toBytes,
} from './encode.js';
import { Mp4Writer, type Mp4Sample } from './mp4.js';
import { planDecode, sampleClip, type DecodeSegment } from './sample.js';

/**
 * The export.
 *
 * ## How a frame is made
 *
 * Decoding is done by a `<video>` element, not by `VideoDecoder`. That is a deliberate
 * concession and worth stating plainly: driving `VideoDecoder` means first demuxing the
 * container, and the container here is whatever an iPhone wrote — HEVC in a QuickTime
 * file, with edit lists and rotation and a variable frame rate. Writing that demuxer is a
 * project in itself, and the phone already contains a decoder that handles all of it. So
 * the platform decodes, and everything downstream of the decoded picture — the framing,
 * the timing, the encoding, the container — is ours.
 *
 * The element plays; each presented frame is drawn through `sampleClip`, which is the same
 * function the preview scrubber uses; the canvas is encoded at the timeline's own frame
 * rate. Because the output timestamps come from a frame counter rather than from the
 * source, the result is exactly constant-frame-rate no matter how erratically the source
 * was recorded — and speed changes cost nothing, because a 2x clip simply consumes source
 * frames twice as fast while output timestamps keep their steady beat.
 *
 * ## What that costs
 *
 * Capture runs at playback speed: a 90-second edit takes about 90 seconds to export, less
 * where clips are sped up. Frame-accurate seeking per frame would be exact but far slower
 * on a phone, so it is kept only as the fallback for browsers without
 * `requestVideoFrameCallback`.
 *
 * The tolerance this buys: an output frame can show a source frame up to one source-frame
 * early. At 30fps that is 33ms of picture, at a cut point that is already accurate to the
 * microsecond in the EDL. Sound is unaffected — it is mixed from decoded samples against
 * the same timeline, not captured.
 */

/** Resolves a source id to something playable and something decodable. */
export interface MediaResolver {
  /** A URL a `<video>` element can play *and seek*. */
  url(sourceId: string): Promise<string>;
  /**
   * The stored file, for demuxing audio out of. Null when the media is unavailable.
   *
   * A `Blob`, deliberately, not its bytes: phone recordings run to gigabytes, and the
   * whole audio path is built on slicing the parts it needs out of a handle rather than
   * materialising the file. Asking for an `ArrayBuffer` here is what made a real 5.2 GB
   * project export silently silent.
   */
  file(sourceId: string): Promise<Blob | null>;
}

export interface RenderRequest {
  project: Project;
  /** Defaults to `project.timeline`. Pass a snapshot to render an earlier revision. */
  timeline?: Timeline;
  resolver: MediaResolver;
  signal?: AbortSignal;
  /**
   * Cap on the longest output edge. 4K footage encodes slowly enough on a phone to look
   * like a hang, and nothing downstream of this tool wants 4K anyway.
   */
  maxDimension?: number;
  /** Off only for a diagnostic render; the raw sound is the point of the footage. */
  audio?: boolean;
  /** Forces the capture strategy. Left alone, playback is used wherever it is available. */
  strategy?: 'playback' | 'seek';
}

export interface RenderProgress {
  /** 0..1 over the whole export. */
  progress: number;
  framesEncoded: number;
  framesTotal: number;
  stage: 'preparing' | 'audio' | 'encoding' | 'muxing' | 'done';
}

export interface RenderResult {
  blob: Blob;
  durationUs: number;
  framesEncoded: number;
  width: number;
  height: number;
  videoCodec: string;
  /** Null when the export came out silent, with the reason in `warnings`. */
  audioCodec: string | null;
  /** Things that went differently than asked, in language fit to show a person. */
  warnings: string[];
}

export interface Renderer {
  render(request: RenderRequest, onProgress?: (p: RenderProgress) => void): Promise<RenderResult>;
}

/**
 * Sound codecs to try, best first. The picture's ladder lives in `encode.ts`, with the
 * rest of what both the export and the proxy need.
 *
 * AAC leads because the export's destination is an iPhone's camera roll, and that is what
 * it accepts. Opus follows so that a browser without the licensed pair still produces a
 * file — including the Chromium the export's own end-to-end check runs in, which is the
 * only way any of this gets exercised outside a phone.
 */
const AUDIO_CODECS = ['mp4a.40.2', 'opus'] as const;

/** Keyframe interval. Two seconds is the usual compromise between size and seekability. */
const KEYFRAME_SECONDS = 2;

export function isRenderSupported(): boolean {
  return (
    typeof globalThis.VideoEncoder === 'function' &&
    typeof globalThis.VideoFrame === 'function' &&
    typeof globalThis.OffscreenCanvas !== 'undefined'
  );
}

export function createRenderer(): Renderer {
  return { render: renderProject };
}

export async function renderProject(
  request: RenderRequest,
  onProgress?: (progress: RenderProgress) => void,
): Promise<RenderResult> {
  if (!isRenderSupported()) {
    throw new Error('This browser cannot encode video. Try Safari 17+, Chrome, or Edge.');
  }

  const timeline = request.timeline ?? request.project.timeline;
  const segments = planDecode(timeline);
  if (segments.length === 0) throw new Error('There is nothing to export: every clip is dropped.');

  const out = outputSize(timeline, request.maxDimension ?? 1920);
  const frameDurationUs = (1_000_000 * timeline.frameRate.den) / timeline.frameRate.num;
  const framesTotal = Math.max(1, Math.ceil(timelineDuration(timeline) / frameDurationUs));
  const warnings: string[] = [];
  const report = (stage: RenderProgress['stage'], framesEncoded: number) =>
    onProgress?.({ stage, framesEncoded, framesTotal, progress: Math.min(1, framesEncoded / framesTotal) });

  report('preparing', 0);

  const videoCodec = await pickVideoCodec(out);
  if (!videoCodec) throw new Error('This browser has no video encoder EvoCut can use.');

  // Audio first, and released before the video pass begins: a decoded source and a
  // mixdown are tens of megabytes each, and a phone that is about to hold every encoded
  // frame in memory should not still be holding those too.
  report('audio', 0);
  const warningsBefore = warnings.length;
  const audio = request.audio === false ? null : await renderAudio(timeline, request, warnings);
  if (request.audio !== false && !audio && warnings.length === warningsBefore) {
    warnings.push('The export has no sound: this browser could not decode the audio in this recording.');
  }

  const videoSamples: Mp4Sample[] = [];
  let videoDescription: Uint8Array | undefined;
  // An encoder reports failure through its own callback, on its own turn of the event
  // loop. Throwing from in there escapes into nothing, so the error is parked and
  // rethrown from the render path that can actually be caught.
  let encoderError: unknown = null;

  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      const description = metadata?.decoderConfig?.description;
      if (description && !videoDescription) videoDescription = toBytes(description);
      videoSamples.push(chunkToSample(chunk));
    },
    error: (error) => {
      encoderError = error;
    },
  });

  encoder.configure({
    codec: videoCodec,
    width: out.width,
    height: out.height,
    framerate: timeline.frameRate.num / timeline.frameRate.den,
    bitrate: bitrateFor(out),
    latencyMode: 'quality',
    ...(videoCodec.startsWith('avc') ? { avc: { format: 'avc' as const } } : {}),
  });

  const canvas = new OffscreenCanvas(out.width, out.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Could not open a drawing surface for the export.');

  const media = new MediaPool(request.resolver);
  const capture = new Capture({
    timeline,
    out,
    canvas,
    ctx,
    encoder,
    frameDurationUs,
    keyframeEvery: Math.max(1, Math.round((KEYFRAME_SECONDS * timeline.frameRate.num) / timeline.frameRate.den)),
    signal: request.signal,
    onFrame: (count) => report('encoding', count),
  });

  try {
    for (const segment of segments) {
      throwIfAborted(request.signal);
      if (encoderError) throw encoderError;
      const source = await media.open(segment.sourceId);
      const strategy =
        request.strategy ?? (typeof source.video.requestVideoFrameCallback === 'function' ? 'playback' : 'seek');
      if (strategy === 'playback') await capture.byPlayback(segment, source);
      else await capture.bySeeking(segment, source);
    }

    await encoder.flush();
    if (encoderError) throw encoderError;
  } finally {
    media.release();
    if (encoder.state !== 'closed') encoder.close();
  }

  if (videoSamples.length === 0) throw new Error('The encoder produced no frames.');

  report('muxing', capture.framesEncoded);

  const writer = new Mp4Writer();
  const videoTrack = writer.addVideoTrack({
    codec: videoCodec,
    ...(videoDescription ? { description: videoDescription } : {}),
    width: out.width,
    height: out.height,
  });
  for (const sample of videoSamples) writer.addSample(videoTrack, sample);

  if (audio) {
    const audioTrack = writer.addAudioTrack({
      codec: audio.codec,
      ...(audio.description ? { description: audio.description } : {}),
      sampleRate: audio.sampleRate,
      channels: audio.channels,
    });
    for (const sample of audio.samples) writer.addSample(audioTrack, sample);
  }

  const { blob, durationUs } = writer.finalize();
  report('done', capture.framesEncoded);

  return {
    blob,
    durationUs,
    framesEncoded: capture.framesEncoded,
    width: out.width,
    height: out.height,
    videoCodec,
    audioCodec: audio?.codec ?? null,
    warnings,
  };
}

/**
 * Frame capture, in the two ways a browser will give up its decoded pictures.
 *
 * Holding these together in one object is what keeps them honest: both drive the same
 * `emit`, so a difference between the two strategies can only be *which* source frame is
 * on screen, never where the output frames land.
 */
class Capture {
  framesEncoded = 0;
  /** Global frame counter. Output timestamps are `index * frameDuration`, always. */
  #index = 0;

  constructor(
    private readonly deps: {
      timeline: Timeline;
      out: FrameSize;
      canvas: OffscreenCanvas;
      ctx: OffscreenCanvasRenderingContext2D;
      encoder: VideoEncoder;
      frameDurationUs: number;
      keyframeEvery: number;
      signal?: AbortSignal | undefined;
      onFrame(count: number): void;
    },
  ) {}

  get #next(): number {
    return Math.round(this.#index * this.deps.frameDurationUs);
  }

  /**
   * Play the clip and take whatever the decoder presents.
   *
   * The loop is driven by the source's own presentation times, not by a clock: each frame
   * that arrives says how far into the source it is, and every output frame due at or
   * before that point is emitted from it. A decoder that stalls, drops, or delivers late
   * therefore changes the picture slightly and the timing not at all.
   */
  async byPlayback(segment: DecodeSegment, source: OpenSource): Promise<void> {
    const { clip } = segment;
    const video = source.video;

    video.playbackRate = Math.min(16, Math.max(0.0625, clip.speed));
    await seekTo(video, clip.sourceIn);
    await video.play().catch(() => {
      // A refusal here is a policy problem, not a decode problem; the fill below still
      // produces a correct-length segment, and the seek path is the real remedy.
    });

    while (this.#next < segment.outEnd) {
      throwIfAborted(this.deps.signal);

      const presented = await nextPresentedFrame(video, FRAME_TIMEOUT_MS);
      if (presented === null) break;

      const sourceUs = secondsToMicros(presented);
      // Frames from before the seek landed: the element may present one or two of these
      // while it is still catching up, and drawing them would put the previous shot at
      // the head of this one.
      if (sourceUs + this.deps.frameDurationUs < clip.sourceIn) continue;

      const upTo = clip.start + (sourceUs - clip.sourceIn) / clip.speed;
      while (this.#next <= upTo && this.#next < segment.outEnd) {
        await this.#emit(segment, source);
      }

      if (sourceUs >= clip.sourceOut || video.ended) break;
    }

    video.pause();

    // Whatever the decoder never delivered — a stall, an early `ended`, a clip trimmed to
    // the last frame of the file — is filled from the last picture drawn. The segment
    // occupies exactly the length the EDL says it does, or the cut after it moves.
    while (this.#next < segment.outEnd) {
      throwIfAborted(this.deps.signal);
      await this.#emit(segment, source);
    }
  }

  /** Exact, and slow: one seek per output frame. For browsers with no frame callback. */
  async bySeeking(segment: DecodeSegment, source: OpenSource): Promise<void> {
    while (this.#next < segment.outEnd) {
      throwIfAborted(this.deps.signal);
      const layer = sampleClip(segment.clip, this.#next);
      await seekTo(source.video, layer ? layer.sourceTime : segment.clip.sourceIn);
      await this.#emit(segment, source);
    }
  }

  async #emit(segment: DecodeSegment, source: OpenSource): Promise<void> {
    const time = this.#next;
    const { ctx, out, timeline, canvas, encoder, frameDurationUs } = this.deps;

    clearFrame(ctx, out, timeline.background);
    const layer = sampleClip(segment.clip, time);
    if (layer) drawLayer(ctx, source.video, source.size, layer, out);

    const frame = new VideoFrame(canvas, { timestamp: time, duration: Math.round(frameDurationUs) });
    try {
      encoder.encode(frame, { keyFrame: this.framesEncoded % this.deps.keyframeEvery === 0 });
    } finally {
      frame.close();
    }

    this.#index += 1;
    this.framesEncoded += 1;
    this.deps.onFrame(this.framesEncoded);

    // Backpressure. Without it a phone builds a queue of full-resolution frames it has no
    // memory for, and the tab is killed somewhere around the thirty-second mark.
    if (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
      const wasPlaying = !source.video.paused;
      source.video.pause();
      while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE / 2) await tick();
      if (wasPlaying) await source.video.play().catch(() => {});
    }
  }
}

interface OpenSource {
  video: HTMLVideoElement;
  size: FrameSize;
}

/** Video elements, one per source, kept alive for the whole export and torn down together. */
class MediaPool {
  #open = new Map<string, OpenSource>();

  constructor(private readonly resolver: MediaResolver) {}

  async open(sourceId: string): Promise<OpenSource> {
    const existing = this.#open.get(sourceId);
    if (existing) return existing;

    const url = await this.resolver.url(sourceId);
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    // In the document, because some iOS versions will not decode for a detached element —
    // the same reason the filmstrip extractor does this.
    video.style.cssText =
      'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
    document.body.appendChild(video);

    await onceEvent(video, 'loadeddata', SEEK_TIMEOUT_MS);
    if (!video.videoWidth) throw new Error('The source video reported no picture size.');
    if (video.seekable.length === 0) {
      throw new Error('This browser cannot seek inside the source video, so it cannot be exported.');
    }

    const opened = { video, size: { width: video.videoWidth, height: video.videoHeight } };
    this.#open.set(sourceId, opened);
    return opened;
  }

  release(): void {
    for (const { video } of this.#open.values()) {
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
    }
    this.#open.clear();
  }
}

interface RenderedAudio {
  codec: string;
  description?: Uint8Array;
  sampleRate: number;
  channels: number;
  samples: Mp4Sample[];
}

/**
 * Decode every source's audio, mix it against the timeline, and encode the result.
 *
 * Returns null for any reason at all — no encoder, no decodable audio, a codec the browser
 * will not take. A silent export is a disappointment; a failed export is a wasted minute
 * of a phone's battery and the user's time, so this never throws.
 */
async function renderAudio(
  timeline: Timeline,
  request: RenderRequest,
  warnings: string[],
): Promise<RenderedAudio | null> {
  if (typeof globalThis.AudioEncoder !== 'function' || typeof globalThis.AudioData !== 'function') {
    return null;
  }

  const clips = await decodeClipAudio(timeline, request, warnings);
  if (clips.size === 0) return null;

  const mix = await mixdown(timeline, clips, { sampleRate: AUDIO_SAMPLE_RATE }).catch(() => null);
  clips.clear();
  if (!mix) return null;

  const codec = await pickAudioCodec(mix.sampleRate, mix.numberOfChannels);
  if (!codec) {
    warnings.push('This browser has no audio encoder EvoCut can use, so the export is silent.');
    return null;
  }

  const samples: Mp4Sample[] = [];
  let description: Uint8Array | undefined;
  let failure: unknown = null;

  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      const supplied = metadata?.decoderConfig?.description;
      if (supplied && !description) description = toBytes(supplied);
      samples.push(chunkToSample(chunk));
    },
    error: (error) => {
      failure = error;
    },
  });
  encoder.configure({
    codec,
    sampleRate: mix.sampleRate,
    numberOfChannels: mix.numberOfChannels,
    bitrate: 128_000,
  });

  // Fed in slices rather than as one buffer: an `AudioData` holds a copy of everything it
  // is given, and a whole mixdown is large enough that handing it over in one piece
  // doubles peak memory for no benefit.
  const SLICE = 48_000;
  for (let at = 0; at < mix.length; at += SLICE) {
    throwIfAborted(request.signal);
    const frames = Math.min(SLICE, mix.length - at);
    encoder.encode(
      new AudioData({
        format: 'f32-planar',
        sampleRate: mix.sampleRate,
        numberOfFrames: frames,
        numberOfChannels: mix.numberOfChannels,
        timestamp: Math.round((at / mix.sampleRate) * 1_000_000),
        data: toPlanar(mix, at, frames),
      }),
    );
    if (encoder.encodeQueueSize > 4) {
      while (encoder.encodeQueueSize > 2) await tick();
    }
  }

  try {
    await encoder.flush();
  } catch (error) {
    failure = error;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }

  if (failure || samples.length === 0) {
    warnings.push('The audio failed to encode, so the export is silent.');
    return null;
  }

  return {
    codec,
    ...(description ? { description } : {}),
    sampleRate: mix.sampleRate,
    channels: mix.numberOfChannels,
    samples,
  };
}

/**
 * Decode exactly the audio the edit uses, clip by clip.
 *
 * Where the container can be demuxed this reads only the frames each surviving clip
 * covers — nine minutes of a twenty-seven-minute recording costs nine minutes of memory,
 * not twenty-seven. Where it cannot (WebM, fragmented MP4) it falls back to decoding the
 * whole file, which is correct but only survivable for small ones.
 */
async function decodeClipAudio(
  timeline: Timeline,
  request: RenderRequest,
  warnings: string[],
): Promise<Map<string, ClipAudio>> {
  const decoded = new Map<string, ClipAudio>();
  const bySource = new Map<string, ReturnType<typeof planAudio>>();
  for (const segment of planAudio(timeline)) {
    const list = bySource.get(segment.sourceId) ?? [];
    list.push(segment);
    bySource.set(segment.sourceId, list);
  }

  for (const [sourceId, segments] of bySource) {
    throwIfAborted(request.signal);
    const file = await request.resolver.file(sourceId).catch(() => null);
    if (!file) continue;

    const track = isAudioDecodeSupported() ? await readAudioTrack(file).catch(() => null) : null;
    if (track) {
      let any = false;
      for (const segment of segments) {
        throwIfAborted(request.signal);
        const fromUs = secondsToMicros(segment.offset);
        const toUs = fromUs + secondsToMicros(segment.duration);
        const buffer = await decodeAudioWindow(file, track, fromUs, toUs, {
          ...(request.signal ? { signal: request.signal } : {}),
        }).catch(() => null);
        if (buffer) {
          decoded.set(segment.clipId, { buffer, startUs: fromUs });
          any = true;
        }
      }
      // A track this browser can index but not decode — an ALAC or AC-3 recording — falls
      // through to the whole-file path, which may still know how to play it.
      if (any) continue;
    }

    if (file.size > MAX_UNINDEXED_AUDIO_BYTES) {
      warnings.push(
        'The sound in this recording could not be read: the file is too large to decode without an index, ' +
          'and its container is one EvoCut cannot index. The export has picture only.',
      );
      continue;
    }

    const whole = await decodeAudio(await file.arrayBuffer(), AUDIO_SAMPLE_RATE);
    if (!whole) continue;
    for (const segment of segments) decoded.set(segment.clipId, { buffer: whole, startUs: 0 });
  }

  return decoded;
}


async function pickAudioCodec(sampleRate: number, channels: number): Promise<string | null> {
  for (const codec of AUDIO_CODECS) {
    const supported = await AudioEncoder.isConfigSupported({
      codec,
      sampleRate,
      numberOfChannels: channels,
      bitrate: 128_000,
    }).catch(() => null);
    if (supported?.supported) return codec;
  }
  return null;
}



function outputSize(timeline: Timeline, maxDimension: number): FrameSize {
  const { width, height } = timeline.resolution;
  const longest = Math.max(width, height);
  const scale = longest > maxDimension ? maxDimension / longest : 1;
  // Encoders want even dimensions: chroma is subsampled by two on both axes, and an odd
  // edge is rejected outright by some and silently cropped by others.
  return { width: even(width * scale), height: even(height * scale) };
}









/** Clips grouped by the source they decode from, for callers planning their own passes. */
export function sourcesInTimeline(timeline: Timeline): string[] {
  return [...new Set(timeline.tracks.flatMap((track) => track.clips.map((clip: Clip) => clip.sourceId)))];
}
