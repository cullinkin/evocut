import type { AudioSampleRef, SourceAudioTrack } from './demux.js';

/**
 * Turning a demuxed audio track into samples, a slice at a time.
 *
 * `demux.ts` says where every audio frame lives. This reads those frames — and only those
 * frames — out of the file and pushes them through `AudioDecoder`. Peak memory is a few
 * megabytes regardless of how long the recording is, which is the entire point: the path
 * this replaces held the whole file, and on a 5.2 GB recording it held nothing at all
 * because it never got that far.
 *
 * ## Two shapes of output, for two callers
 *
 * The signals pass wants the *whole* recording but only its loudness, so
 * `decodeAudioEnvelope` decimates on the way past and returns about 13 MB for half an hour
 * of audio. The export wants *exact* samples but only for the clips that survived, so
 * `decodeAudioWindow` decodes one span at full rate and nothing else.
 *
 * ### Why the envelope stays faithful
 *
 * Each output value is the root-mean-square of the input block it replaces, not its
 * average. Averaging a waveform is a low-pass filter and would quietly delete the loudness
 * of anything bright — a clap would land as a shrug. Taking RMS per block means the RMS of
 * the decimated signal over any window equals the RMS of the original over that window,
 * exactly, so the envelope, the onsets, and the quiet runs downstream are the same numbers
 * they would have been at full rate. What is lost is phase and pitch, which nothing in the
 * signals pass looks at.
 */

export interface PcmFrame {
  /**
   * One array per channel.
   *
   * Reused between calls — a sink that wants to keep these must copy them. Decoding half
   * an hour of audio is tens of thousands of frames, and allocating a fresh pair of
   * buffers for each is measurable on a phone.
   */
  channels: Float32Array[];
  frames: number;
  sampleRate: number;
  /** Presentation time of the first sample, within the source, in microseconds. */
  timestampUs: number;
}

export type PcmSink = (frame: PcmFrame) => void;

export interface DecodeAudioOptions {
  /** Window within the source, in microseconds. Defaults to the whole track. */
  fromUs?: number;
  toUs?: number;
  signal?: AbortSignal;
  /** 0..1 over the requested window. */
  onProgress?(fraction: number): void;
}

/**
 * The largest file worth handing to `decodeAudioData` whole.
 *
 * That is the only route into a container this module cannot index — Matroska, fragmented
 * MP4 — and it takes the entire file as one `ArrayBuffer`. Half a gigabyte is already an
 * unkind thing to ask of a phone; five gigabytes is not a slow decode, it is a dead tab.
 * Callers check this and say so, rather than trying it and reporting silence.
 */
export const MAX_UNINDEXED_AUDIO_BYTES = 400 * 1024 * 1024;

/** How many frames of lead-in to decode before the requested window. */
const PREROLL_FRAMES = 2;
/** Frames in flight before the reader waits for the decoder. */
const MAX_DECODE_QUEUE = 24;
/** A read may span this much unrelated data rather than starting a new one. */
const MAX_READ_GAP = 512 * 1024;
/** Ceiling on one `Blob.slice` read. */
const MAX_READ_BYTES = 4 * 1024 * 1024;

export function isAudioDecodeSupported(): boolean {
  return typeof globalThis.AudioDecoder === 'function' && typeof globalThis.EncodedAudioChunk === 'function';
}

/**
 * Decode a span of a track, pushing PCM to a sink as it arrives.
 *
 * Returns false when nothing could be decoded — no decoder, a codec this browser refuses,
 * a track with no frames in the window. Every caller has somewhere to go from there, so
 * this reports rather than throws.
 */
export async function decodeAudioRange(
  file: Blob,
  track: SourceAudioTrack,
  sink: PcmSink,
  options: DecodeAudioOptions = {},
): Promise<boolean> {
  if (!isAudioDecodeSupported() || track.samples.length === 0) return false;

  const fromUs = Math.max(0, options.fromUs ?? 0);
  const toUs = options.toUs ?? track.durationUs;
  if (toUs <= fromUs) return false;

  const config: AudioDecoderConfig = {
    codec: track.codec,
    sampleRate: track.sampleRate,
    numberOfChannels: track.channels,
    ...(track.description ? { description: track.description as BufferSource } : {}),
  };
  const supported = await AudioDecoder.isConfigSupported(config).catch(() => null);
  if (!supported?.supported) return false;

  const wanted = selectSamples(track.samples, fromUs, toUs);
  if (wanted.length === 0) return false;

  const scratch: Float32Array[] = [];
  let decoded = 0;
  let failure: unknown = null;

  const decoder = new AudioDecoder({
    output: (data) => {
      try {
        // `f32-planar` is the one format every implementation must be able to convert to,
        // so asking for it here means this never has to know what the decoder emits.
        for (let channel = 0; channel < data.numberOfChannels; channel += 1) {
          const size = data.allocationSize({ planeIndex: channel, format: 'f32-planar' }) / 4;
          let buffer = scratch[channel];
          if (!buffer || buffer.length < size) {
            buffer = new Float32Array(size);
            scratch[channel] = buffer;
          }
          data.copyTo(buffer.subarray(0, size), { planeIndex: channel, format: 'f32-planar' });
        }
        sink({
          channels: scratch.slice(0, data.numberOfChannels),
          frames: data.numberOfFrames,
          sampleRate: data.sampleRate,
          timestampUs: data.timestamp,
        });
        decoded += data.numberOfFrames;
      } catch (error) {
        failure = error;
      } finally {
        data.close();
      }
    },
    error: (error) => {
      // Reported from the decoder's own turn of the event loop, where a throw would escape
      // into nothing. Parked, and raised by the loop below.
      failure = error;
    },
  });

  decoder.configure(config);

  try {
    for (const batch of readBatches(file, wanted)) {
      throwIfAborted(options.signal);
      if (failure) break;

      const bytes = new Uint8Array(await batch.read);
      for (const sample of batch.samples) {
        const at = sample.offset - batch.start;
        decoder.decode(
          new EncodedAudioChunk({
            // Every audio frame stands alone; there are no inter-frame dependencies to
            // declare, which is also why a window can start anywhere.
            type: 'key',
            timestamp: sample.timestampUs,
            duration: sample.durationUs,
            data: bytes.subarray(at, at + sample.size),
          }),
        );
      }

      options.onProgress?.(
        Math.min(1, (batch.samples.at(-1)!.timestampUs - fromUs) / Math.max(1, toUs - fromUs)),
      );
      while (decoder.decodeQueueSize > MAX_DECODE_QUEUE) await tick();
    }

    if (!failure) await decoder.flush();
  } catch (error) {
    failure = error;
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }

  if (failure instanceof Error && failure.name === 'AbortError') throw failure;
  return decoded > 0;
}

export interface AudioEnvelope {
  /** Per-block RMS magnitude, mono. */
  samples: Float32Array;
  sampleRate: number;
}

/**
 * The whole recording's loudness, at a rate the signals pass can hold.
 *
 * 2 kHz is forty times the analysis hop, so nothing downstream can tell the difference,
 * and half an hour of audio comes to 13 MB instead of 622 MB.
 */
export async function decodeAudioEnvelope(
  file: Blob,
  track: SourceAudioTrack,
  options: DecodeAudioOptions & { rate?: number } = {},
): Promise<AudioEnvelope | null> {
  const rate = options.rate ?? 2000;
  const fromUs = Math.max(0, options.fromUs ?? 0);
  const toUs = options.toUs ?? track.durationUs;
  const blocks = Math.max(1, Math.ceil(((toUs - fromUs) / 1_000_000) * rate) + 1);

  const sums = new Float64Array(blocks);
  const counts = new Uint32Array(blocks);

  const ok = await decodeAudioRange(
    file,
    track,
    (frame) => {
      // Placed by timestamp rather than by running count, so a gap in the file leaves a
      // gap here instead of shifting everything after it earlier.
      const base = ((frame.timestampUs - fromUs) / 1_000_000) * rate;
      const perSample = rate / frame.sampleRate;
      const channels = frame.channels;

      for (let i = 0; i < frame.frames; i += 1) {
        const block = Math.floor(base + i * perSample);
        if (block < 0 || block >= blocks) continue;
        let value = 0;
        for (const channel of channels) value += channel[i] ?? 0;
        value /= channels.length;
        sums[block]! += value * value;
        counts[block]! += 1;
      }
    },
    options,
  );
  if (!ok) return null;

  const samples = new Float32Array(blocks);
  for (let i = 0; i < blocks; i += 1) {
    samples[i] = counts[i]! > 0 ? Math.sqrt(sums[i]! / counts[i]!) : 0;
  }
  return { samples, sampleRate: rate };
}

/**
 * Exact samples for one span, as an `AudioBuffer` starting at `fromUs`.
 *
 * At the track's own rate, not the mix's: an `AudioBufferSourceNode` resamples whatever it
 * is given, so converting here would be a second resample for nothing.
 */
export async function decodeAudioWindow(
  file: Blob,
  track: SourceAudioTrack,
  fromUs: number,
  toUs: number,
  options: DecodeAudioOptions = {},
): Promise<AudioBuffer | null> {
  if (typeof globalThis.AudioBuffer !== 'function') return null;

  const rate = track.sampleRate;
  const length = Math.max(1, Math.ceil(((toUs - fromUs) / 1_000_000) * rate));
  const channels = Math.max(1, track.channels);
  // Backed by an explicit `ArrayBuffer` so the type is the non-shared one `copyToChannel`
  // asks for; the same reason `toPlanar` allocates this way.
  const planes: Float32Array<ArrayBuffer>[] = [];
  for (let i = 0; i < channels; i += 1) planes.push(new Float32Array(new ArrayBuffer(length * 4)));

  const ok = await decodeAudioRange(
    file,
    track,
    (frame) => {
      const at = Math.round(((frame.timestampUs - fromUs) / 1_000_000) * rate);
      for (let channel = 0; channel < planes.length; channel += 1) {
        // A mono source feeding a stereo buffer, or the reverse: the last available
        // channel is repeated rather than dropping to silence on one side.
        const from = frame.channels[Math.min(channel, frame.channels.length - 1)];
        if (!from) continue;
        const start = Math.max(0, at);
        const skip = start - at;
        const take = Math.min(frame.frames - skip, length - start);
        if (take > 0) planes[channel]!.set(from.subarray(skip, skip + take), start);
      }
    },
    { ...options, fromUs, toUs },
  );
  if (!ok) return null;

  const buffer = new AudioBuffer({ length, numberOfChannels: channels, sampleRate: rate });
  for (let channel = 0; channel < channels; channel += 1) buffer.copyToChannel(planes[channel]!, channel);
  return buffer;
}

// --- Reading -------------------------------------------------------------------------

interface ReadBatch {
  start: number;
  samples: AudioSampleRef[];
  read: Promise<ArrayBuffer>;
}

/**
 * The frames overlapping a window, with a little lead-in.
 *
 * The pre-roll is not about correctness — every frame is independently decodable — but
 * about the first frame or two arriving with the decoder still settling, which is audible
 * as a click at the head of a clip.
 */
function selectSamples(samples: AudioSampleRef[], fromUs: number, toUs: number): AudioSampleRef[] {
  let first = samples.findIndex((sample) => sample.timestampUs + sample.durationUs > fromUs);
  if (first === -1) return [];
  first = Math.max(0, first - PREROLL_FRAMES);

  let last = first;
  while (last < samples.length && samples[last]!.timestampUs < toUs) last += 1;
  return samples.slice(first, last);
}

/**
 * Group frames into as few reads as possible.
 *
 * Audio and video are interleaved in the file, so consecutive audio frames are contiguous
 * within a chunk and megabytes apart across one. Reading straight over a small gap costs
 * some wasted bytes and saves a round trip; reading over a large one would mean pulling in
 * video, which is the thing this whole module exists to avoid.
 */
function* readBatches(file: Blob, samples: AudioSampleRef[]): Generator<ReadBatch> {
  let index = 0;
  while (index < samples.length) {
    const start = samples[index]!.offset;
    let end = start + samples[index]!.size;
    const batch: AudioSampleRef[] = [samples[index]!];
    index += 1;

    while (index < samples.length) {
      const next = samples[index]!;
      const gap = next.offset - end;
      if (gap < 0 || gap > MAX_READ_GAP || next.offset + next.size - start > MAX_READ_BYTES) break;
      batch.push(next);
      end = next.offset + next.size;
      index += 1;
    }

    yield { start, samples: batch, read: file.slice(start, end).arrayBuffer() };
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('Cancelled.');
  error.name = 'AbortError';
  throw error;
}
