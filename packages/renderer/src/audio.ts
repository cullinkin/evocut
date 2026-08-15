import {
  clipEnd,
  microsToSeconds,
  outputDuration,
  timelineDuration,
  type Clip,
  type Timeline,
  type VolumeEffect,
} from '@evocut/edl';

/**
 * The audio side of the export.
 *
 * There is no music track and there never will be one in this pass: the sound is whatever
 * the camera heard, and sound effects get added later in another app. That makes the job
 * narrow and worth doing properly — the diegetic audio is the only thing tying the picture
 * to the moment it was shot, and an export that drifts out of sync by a frame per cut is
 * worse than useless.
 *
 * ## Planned, then executed
 *
 * `planAudio` is pure: timeline in, a schedule out. `mixdown` feeds that schedule to an
 * `OfflineAudioContext`. The split is what makes the timing testable at all — Web Audio
 * has no offline equivalent outside a browser, and the part that can be wrong is the
 * arithmetic, not the plumbing.
 *
 * Speed changes are done the way every editor does them by default: resample, so a 2x clip
 * is also an octave up. Pitch-preserving time compression is a different feature, and
 * pretending otherwise by silently varispeeding while calling it a speed-up would make the
 * refinement pass's speed decisions unpredictable.
 */

export interface GainPoint {
  /** Absolute time on the output timeline, in seconds. */
  at: number;
  value: number;
  /** `hold` steps to the value; anything else ramps to it. */
  step: boolean;
}

export interface AudioSegment {
  clipId: string;
  sourceId: string;
  /** Start on the output timeline, in seconds. */
  at: number;
  /** Where to start reading the source, in seconds. */
  offset: number;
  /** How much source to read, in seconds — before speed is applied. */
  duration: number;
  /** Playback rate. Also a pitch shift; see above. */
  rate: number;
  /** Gain for the whole segment, before any ramps. */
  gain: number;
  /** Volume automation, already folded together and in absolute output seconds. */
  ramps: GainPoint[];
}

/** Which clips make sound, when, and how loudly. */
export function planAudio(timeline: Timeline): AudioSegment[] {
  const segments: AudioSegment[] = [];

  for (const track of timeline.tracks) {
    // An overlay track is titles and graphics. It has no sound of its own, and treating
    // its source's audio as part of the mix would double whatever it was cut from.
    if (track.kind === 'overlay' || track.muted) continue;

    for (const clip of track.clips) {
      if (!clip.enabled || clip.audio.mute || clip.audio.gain <= 0) continue;
      if (outputDuration(clip) <= 0) continue;

      segments.push({
        clipId: clip.id,
        sourceId: clip.sourceId,
        at: microsToSeconds(clip.start),
        offset: microsToSeconds(clip.sourceIn),
        duration: microsToSeconds(clip.sourceOut - clip.sourceIn),
        rate: clip.speed,
        gain: clip.audio.gain,
        ramps: volumeRamps(clip),
      });
    }
  }

  return segments.sort((a, b) => a.at - b.at);
}

/**
 * Volume keyframes, flattened to absolute output time.
 *
 * Several volume effects on one clip multiply, which the EDL allows and the sampler
 * already honours — so they are combined here at the union of their keyframe times rather
 * than scheduled as separate stages. Eased curves become linear ramps: a Web Audio param
 * has no ease-in-out, and over the length of a fade the difference is inaudible.
 */
function volumeRamps(clip: Clip): GainPoint[] {
  const effects = clip.effects.filter(
    (effect): effect is VolumeEffect => effect.enabled && effect.type === 'volume',
  );
  if (effects.length === 0) return [];

  const times = [...new Set(effects.flatMap((effect) => effect.keyframes.map((k) => k.t)))].sort(
    (a, b) => a - b,
  );
  const start = microsToSeconds(clip.start);

  return times.map((t) => {
    let value = 1;
    let step = false;
    for (const effect of effects) {
      const before = lastAtOrBefore(effect.keyframes, t);
      value *= before?.value ?? effect.keyframes[0]!.value;
      if (before?.easing === 'hold') step = true;
    }
    return { at: start + microsToSeconds(t), value, step };
  });
}

function lastAtOrBefore<T extends { t: number }>(keyframes: T[], t: number): T | undefined {
  let found: T | undefined;
  for (const keyframe of keyframes) {
    if (keyframe.t <= t) found = keyframe;
    else break;
  }
  return found;
}

/** The bits of `OfflineAudioContext` this module needs, so a test can stand in for it. */
export interface OfflineAudio {
  sampleRate: number;
  destination: AudioNode;
  createBufferSource(): AudioBufferSourceNode;
  createGain(): GainNode;
  startRendering(): Promise<AudioBuffer>;
}

export interface MixdownOptions {
  sampleRate?: number;
  channels?: number;
  /** Injected so the browser's constructor is not hard-wired into the module. */
  createContext?(channels: number, frames: number, sampleRate: number): OfflineAudio;
}

const DEFAULT_SAMPLE_RATE = 48_000;

/**
 * Decoded audio for one clip.
 *
 * Keyed per clip rather than per source, and carrying where in the source it starts, so a
 * nine-minute edit of a half-hour recording decodes nine minutes. The alternative — one
 * buffer per source — meant holding the *whole* take in memory whatever survived the cut,
 * which on phone footage is hundreds of megabytes for audio nobody kept.
 *
 * `startUs` is what makes that possible: it says where sample zero of this buffer sits in
 * the source, so a window decoded from 12:04 still lines up with a clip that reads from
 * 12:04. A whole-source buffer is simply one with `startUs: 0`, which is what the fallback
 * path for containers we cannot demux still produces.
 */
export interface ClipAudio {
  buffer: AudioBuffer;
  /** Source time of the buffer's first sample, in microseconds. */
  startUs: number;
}

/**
 * Render the timeline's audio to a single buffer.
 *
 * Returns null when there is nothing to render — every clip muted, or nothing decoded.
 * That is a normal outcome (a silent take, a project whose audio the browser could not
 * decode), not a failure, and the export continues without an audio track.
 */
export async function mixdown(
  timeline: Timeline,
  clips: Map<string, ClipAudio>,
  options: MixdownOptions = {},
): Promise<AudioBuffer | null> {
  const segments = planAudio(timeline).filter((segment) => clips.has(segment.clipId));
  if (segments.length === 0) return null;

  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const channels =
    options.channels ??
    Math.min(2, Math.max(1, ...[...clips.values()].map((clip) => clip.buffer.numberOfChannels)));
  const seconds = microsToSeconds(timelineDuration(timeline));
  const frames = Math.max(1, Math.ceil(seconds * sampleRate));

  const context = (options.createContext ?? defaultContext)(channels, frames, sampleRate);

  for (const segment of segments) {
    const decoded = clips.get(segment.clipId)!;
    const source = context.createBufferSource();
    source.buffer = decoded.buffer;
    source.playbackRate.value = segment.rate;

    const gain = context.createGain();
    gain.gain.value = segment.gain;
    for (const point of segment.ramps) {
      const at = Math.max(0, point.at);
      const value = Math.max(0, segment.gain * point.value);
      if (point.step) gain.gain.setValueAtTime(value, at);
      else gain.gain.linearRampToValueAtTime(value, at);
    }

    source.connect(gain);
    gain.connect(context.destination);
    // Reading past the end of a decoded buffer is silence, not an error, so a clip whose
    // source decoded slightly short simply fades out rather than failing the export.
    source.start(
      segment.at,
      Math.max(0, segment.offset - microsToSeconds(decoded.startUs)),
      segment.duration,
    );
  }

  return context.startRendering();
}

function defaultContext(channels: number, frames: number, sampleRate: number): OfflineAudio {
  return new OfflineAudioContext(channels, frames, sampleRate) as unknown as OfflineAudio;
}

/**
 * Decode a source file's audio.
 *
 * Decoded at the export's own sample rate, because `decodeAudioData` resamples to the
 * context's rate on the way out — doing it here means one resample instead of two, and it
 * means every source arrives on the same clock regardless of what it was recorded at.
 *
 * Returns null rather than throwing: a video with no audio track is ordinary, and so is a
 * codec the browser will play but not hand back as samples.
 */
export async function decodeAudio(
  bytes: ArrayBuffer,
  sampleRate = DEFAULT_SAMPLE_RATE,
): Promise<AudioBuffer | null> {
  try {
    const context = new OfflineAudioContext(1, 1, sampleRate);
    return await context.decodeAudioData(bytes);
  } catch {
    return null;
  }
}

/** Channel-by-channel copy of a window of the mix, in the layout `AudioData` wants. */
export function toPlanar(buffer: AudioBuffer, from: number, frames: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(new ArrayBuffer(frames * buffer.numberOfChannels * 4));
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    const take = Math.max(0, Math.min(frames, data.length - from));
    if (take > 0) out.set(data.subarray(from, from + take), channel * frames);
  }
  return out;
}

export { DEFAULT_SAMPLE_RATE as AUDIO_SAMPLE_RATE };
