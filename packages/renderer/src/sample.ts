import {
  NEUTRAL_COLOR,
  clipEnd,
  outputDuration,
  sampleNumber,
  sampleTransform,
  timelineToSource,
  type Clip,
  type ColorValue,
  type CropRect,
  type Timeline,
  type TransformValue,
} from '@evocut/edl';

/**
 * The sampling core: output time in, everything needed to draw one frame out.
 *
 * This is pure and lives outside the WebCodecs plumbing on purpose. It is the same
 * function the preview scrubber calls and the export loop calls, so a preview that looks
 * right is evidence the export will be right — the classic editor bug is two separate
 * implementations of "what is on screen at time t" that disagree at the edges.
 *
 * It is also the proof that the EDL is complete: if a frame cannot be described from the
 * EDL alone, the schema is missing something.
 */

export interface FrameLayer {
  clip: Clip;
  /** Timestamp to decode from the clip's source, in microseconds. */
  sourceTime: number;
  /** Framing to apply when drawing the decoded frame. */
  transform: TransformValue;
  crop: CropRect;
  opacity: number;
  /** Colour and tone for this clip. Static, so it is the same at every instant of it. */
  color: ColorValue;
  /** Combined clip gain and volume keyframes at this instant. */
  gain: number;
  /** How far into the clip's output we are. Handy for debug overlays. */
  clipOffset: number;
}

export interface FrameState {
  /** Output time this state describes. */
  time: number;
  /** Layers to composite, back to front. Empty means draw the background. */
  layers: FrameLayer[];
}

const IDENTITY_TRANSFORM: TransformValue = { scale: 1, x: 0, y: 0, rotation: 0 };
const FULL_FRAME: CropRect = { left: 0, top: 0, right: 1, bottom: 1 };

/** Everything visible and audible at output time `t`. */
export function sampleTimeline(timeline: Timeline, t: number): FrameState {
  const layers: FrameLayer[] = [];

  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      const layer = sampleClip(clip, t);
      if (!layer) continue;
      layers.push(track.muted ? { ...layer, gain: 0 } : layer);
    }
  }

  return { time: t, layers };
}

/**
 * One clip's contribution at output time `t`, or null if it is not on screen then.
 *
 * Split out from `sampleTimeline` for the export, which knows which clip it has decoded
 * and must not accidentally draw the neighbour it is about to cut to — at a boundary the
 * timeline-wide sampler correctly hands back the *next* clip, which is the right answer
 * for a preview and the wrong one for a render loop walking segment by segment.
 */
export function sampleClip(clip: Clip, t: number): FrameLayer | null {
  if (!clip.enabled) return null;
  if (t < clip.start || t >= clipEnd(clip)) return null;

  const sourceTime = timelineToSource(clip, t);
  if (sourceTime === null) return null;

  const offset = t - clip.start;
  return {
    clip,
    sourceTime,
    clipOffset: offset,
    ...sampleEffects(clip, offset),
    gain: clip.audio.mute ? 0 : clip.audio.gain * sampleClipVolume(clip, offset),
  };
}

function sampleEffects(
  clip: Clip,
  offset: number,
): { transform: TransformValue; crop: CropRect; opacity: number; color: ColorValue } {
  let transform = IDENTITY_TRANSFORM;
  let crop = FULL_FRAME;
  let opacity = 1;
  let color = NEUTRAL_COLOR;

  for (const effect of clip.effects) {
    if (!effect.enabled) continue;
    switch (effect.type) {
      case 'transform':
        transform = sampleTransform(effect.keyframes, offset);
        break;
      case 'crop':
        crop = effect.rect;
        break;
      case 'opacity':
        opacity = sampleNumber(effect.keyframes, offset);
        break;
      case 'color':
        color = effect.value;
        break;
      case 'volume':
        break;
    }
  }

  return { transform, crop, opacity, color };
}

function sampleClipVolume(clip: Clip, offset: number): number {
  let gain = 1;
  for (const effect of clip.effects) {
    if (effect.enabled && effect.type === 'volume') gain *= sampleNumber(effect.keyframes, offset);
  }
  return gain;
}

/**
 * The decode work an export needs, one entry per clip, in output order.
 *
 * A renderer cannot seek per frame — it decodes each source range once and walks it.
 * This turns the timeline into that list, and it is where a future optimisation (reusing
 * an open decoder across adjacent clips from the same source) will hook in.
 */
export interface DecodeSegment {
  clip: Clip;
  sourceId: string;
  sourceIn: number;
  sourceOut: number;
  outStart: number;
  outEnd: number;
  /** Frames to emit for this segment at the timeline's output rate. */
  frameCount: number;
}

export function planDecode(timeline: Timeline): DecodeSegment[] {
  const frameDuration = (1_000_000 * timeline.frameRate.den) / timeline.frameRate.num;

  return timeline.tracks
    .filter((track) => track.kind === 'video')
    .flatMap((track) => track.clips)
    .filter((clip) => clip.enabled)
    .sort((a, b) => a.start - b.start)
    .map((clip) => ({
      clip,
      sourceId: clip.sourceId,
      sourceIn: clip.sourceIn,
      sourceOut: clip.sourceOut,
      outStart: clip.start,
      outEnd: clipEnd(clip),
      frameCount: Math.max(1, Math.round(outputDuration(clip) / frameDuration)),
    }));
}
