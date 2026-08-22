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
  /**
   * Times the page was taken away and the run picked itself back up.
   *
   * iOS closes a backgrounded page's codecs, so locking the screen or switching apps in the
   * middle of a fifteen-minute proxy used to end it. Worth counting: a proxy that survived
   * four interruptions and one that was never touched are the same file, and only one of
   * them says anything about how the phone behaved.
   */
  interruptions: number;
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

    let encodeError: Error | null = null;
    let interruptions = 0;
    let keyAt = -Infinity;
    const pending: Mp4Sample[] = [];

    const encoderConfig: VideoEncoderConfig = {
      codec,
      width: out.width,
      height: out.height,
      bitrate: Math.round(bitrateFor(out) * BITRATE_SHARE),
      latencyMode: 'quality',
      ...(codec.startsWith('avc') ? { avc: { format: 'avc' as const } } : {}),
    };

    let encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        // Written every time rather than once: a rebuilt encoder produces its own, and
        // for the same configuration it is the same bytes.
        const description = metadata?.decoderConfig?.description;
        if (description) file.describeTrack(videoTrack, toBytes(description));
        pending.push(chunkToSample(chunk));
      },
      error: (error) => {
        encodeError = error;
      },
    });
    encoder.configure(encoderConfig);

    /*
      What to do when the page comes back.

      iOS takes a backgrounded page's codecs away — both of them — so coming back means
      building a new encoder as well as a new decoder. The next frame is forced to be a
      keyframe, because a fresh encoder has no history to code against and the stream has
      to be decodable across the join.
    */
    const rebuildEncoder = (): void => {
      if (encoder.state !== 'closed') {
        try {
          encoder.close();
        } catch {
          // Already gone, which is the case this exists for.
        }
      }
      encodeError = null;
      encoder = new VideoEncoder({
        output: (chunk, metadata) => {
          const description = metadata?.decoderConfig?.description;
          if (description) file.describeTrack(videoTrack, toBytes(description));
          pending.push(chunkToSample(chunk));
        },
        error: (error) => {
          encodeError = error;
        },
      });
      encoder.configure(encoderConfig);
    };

    const recover = async (): Promise<void> => {
      await whenVisible();
      rebuildEncoder();
      keyAt = -Infinity;
    };

    const sound = audio ? new AudioCopier(request.file, audio) : null;
    let lastAt = -1;

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
      await pumpByDecoding(decodable, request, emit, () => encodeError, recover, () => {
        interruptions += 1;
      });
    } else {
      await pumpByPlayback(video!, request, emit, () => encodeError, warnings);
    }

    /*
      The last stretch, and the one that has to be on screen.

      Flushing the encoder and writing the index are both codec-and-storage work, and a
      page that goes away during them loses a finished run at the final step. So it waits
      for the page rather than pressing on into a decoder that may already be gone.
    */
    report('finishing', 1);
    await whenVisible();
    if (encoder.state === 'closed') {
      // Nothing left to flush from an encoder that was taken away; whatever it had already
      // handed over is written, and the tail of the recording is missing rather than the
      // whole file.
      warnings.push('The page was put away as the proxy finished, so its last moments may be short.');
    } else {
      await encoder.flush();
      if (encodeError) throw encodeError;
      encoder.close();
    }
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
      interruptions,
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
  config: VideoDecoderConfig;
  decoder: VideoDecoder;
  frames: VideoFrame[];
  failure: Error | null;
  /** Build a fresh decoder, after one has been taken away. See `resumable`. */
  reopen(): void;
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
  const state: Decodable = {
    track,
    config,
    decoder: null as unknown as VideoDecoder,
    frames: [],
    failure: null,
    reopen() {
      for (const frame of state.frames) frame.close();
      state.frames = [];
      state.failure = null;
      if (state.decoder?.state !== 'closed') state.decoder?.close();
      state.decoder = new VideoDecoder({
        output: (frame) => state.frames.push(frame),
        error: (error) => {
          state.failure = error;
        },
      });
      state.decoder.configure(config);
    },
  };

  try {
    state.reopen();
  } catch {
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
  const track = await readVideoTrack(file).catch(() => null);
  if (!track) return null;
  const config = decoderConfig(track);
  return config && (await canDecode(track)) ? { track, config } : null;
}

function decoderConfig(track: SourceVideoTrack): VideoDecoderConfig | null {
  if (typeof VideoDecoder !== 'function' || track.count === 0) return null;
  return {
    codec: track.codec,
    codedWidth: track.codedWidth,
    codedHeight: track.codedHeight,
    ...(track.description ? { description: track.description as unknown as BufferSource } : {}),
    optimizeForLatency: false,
  };
}

/**
 * Whether this recording could be decoded without playing it.
 *
 * Takes a track rather than a file, so the answer can be had from an index that has already
 * been read. Reading it twice is what a phone cannot afford — see `SourceVideoTrack`.
 */
export async function canDecode(track: SourceVideoTrack): Promise<boolean> {
  const config = decoderConfig(track);
  if (!config) return false;
  const supported = await VideoDecoder.isConfigSupported(config).catch(() => null);
  return Boolean(supported?.supported);
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
  recover: () => Promise<void>,
  onInterrupted: () => void,
): Promise<void> {
  const { track } = state;

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

  /** The last frame that can be decoded on its own, at or before `index`. */
  const rewind = (index: number): number => {
    for (let at = Math.min(index, track.count - 1); at > 0; at -= 1) {
      if (track.keys[at]) return at;
    }
    return 0;
  };

  let cursor = 0;
  let loadedFrom = -1;
  let loadedTo = -1;
  let bytes: Uint8Array | null = null;

  /*
    Picked up where it was put down, rather than abandoned.

    iOS takes a backgrounded page's codecs away — lock the screen or switch apps and the
    decoder is simply closed underneath you, which after fifteen minutes of work is the
    most expensive way possible to lose it. It cannot be prevented; it can be survived.
    Decoding is driven from the sample table here, so resuming is a matter of building a
    new decoder and starting again at the last frame that can stand on its own. Everything
    between there and where we stopped is decoded a second time and discarded by `emit`,
    which already refuses a timestamp it has passed.
  */
  const resume = async (): Promise<void> => {
    onInterrupted();
    await recover();
    state.reopen();
    cursor = rewind(cursor);
    bytes = null;
  };

  while (cursor < track.count) {
    throwIfAborted(request.signal);

    if (interrupted(state)) {
      await resume();
      continue;
    }
    const error = encodeError() ?? state.failure;
    if (error) {
      if (!interrupted(state)) throw error;
      await resume();
      continue;
    }

    // One read for a run of frames. They are laid down in order, so the run is contiguous
    // and this is a single slice rather than sixty-four.
    if (bytes === null || cursor < loadedFrom || cursor >= loadedTo) {
      loadedFrom = cursor;
      loadedTo = Math.min(track.count, cursor + SAMPLE_BATCH);
      let from = Infinity;
      let to = 0;
      for (let index = loadedFrom; index < loadedTo; index += 1) {
        from = Math.min(from, track.offsets[index]!);
        to = Math.max(to, track.offsets[index]! + track.sizes[index]!);
      }
      bytes = new Uint8Array(await request.file.slice(from, to).arrayBuffer());
      loadedFrom = from;
    }

    const at = track.offsets[cursor]! - loadedFrom;
    try {
      state.decoder.decode(
        new EncodedVideoChunk({
          type: track.keys[cursor] ? 'key' : 'delta',
          timestamp: track.timesUs[cursor]!,
          duration: track.durationsUs[cursor]!,
          data: bytes.subarray(at, at + track.sizes[cursor]!),
        }),
      );
    } catch (cause) {
      // `decode` on a decoder that has been taken away throws rather than reporting.
      if (!interrupted(state)) throw cause;
      await resume();
      continue;
    }
    cursor += 1;

    await take();
    while (state.decoder.decodeQueueSize > MAX_DECODE_QUEUE || state.frames.length > MAX_HELD_FRAMES) {
      throwIfAborted(request.signal);
      if (interrupted(state)) break;
      await tick();
      await take();
    }
  }

  await state.decoder.flush().catch(() => {});
  await take();
  if (state.failure && !interrupted(state)) throw state.failure;
}

/** Whether the page, rather than the recording, is what went wrong. */
function interrupted(state: Decodable): boolean {
  if (typeof document !== 'undefined' && document.hidden) return true;
  if (state.decoder.state === 'closed') return true;
  return /closed/i.test(state.failure?.message ?? '');
}

/** Resolve once the page is on screen again. */
export function whenVisible(): Promise<void> {
  if (typeof document === 'undefined' || !document.hidden) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', check);
      resolve();
    };
    document.addEventListener('visibilitychange', check);
  });
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

/**
 * Roughly how much room a proxy will want, in bytes.
 *
 * The picture at a proxy's bitrate plus the recording's own audio, which is copied through
 * rather than re-encoded. Approximate on purpose — it is used to decide whether there is
 * obviously not enough space, which is a question that does not need three significant
 * figures.
 */
export function proxyBytesEstimate(durationUs: number, audioBytes = 0): number {
  const seconds = microsToSeconds(durationUs);
  // A 1080-long-edge frame lands on the floor in `bitrateFor`, so this is that floor.
  const bitsPerSecond = 2_000_000 * BITRATE_SHARE;
  return Math.round((seconds * bitsPerSecond) / 8 + audioBytes);
}

export function proxyEstimateMs(durationUs: number, from: 'decoder' | 'playback' = 'playback'): number {
  const seconds = microsToSeconds(durationUs);
  return Math.round((seconds * 1000) / (from === 'decoder' ? DECODER_SPEEDUP : 1));
}
