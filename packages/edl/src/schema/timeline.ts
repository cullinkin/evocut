import { z } from 'zod';
import { RationalSchema, Resolution, TimelineId, TrackId } from './common.js';
import { Clip } from './clip.js';

/**
 * Tracks are ordered back-to-front: later tracks composite over earlier ones.
 *
 * v1 of the app produces exactly one `video` track — the coarse pass is a single
 * recording being whittled down, and a phone screen has no room for a stack. The
 * structure is here so that b-roll, captions, and music do not need a schema migration.
 */
export const TrackKind = z.enum(['video', 'audio', 'overlay']);
export type TrackKind = z.infer<typeof TrackKind>;

export const Track = z.object({
  id: TrackId,
  kind: TrackKind.default('video'),
  name: z.string().max(200).optional(),
  /**
   * Clips in playback order. On a `video` track they are contiguous and non-overlapping
   * after normalization: removing a clip ripples everything after it left, which is the
   * behaviour the coarse pass needs (delete a bad take, the video gets shorter).
   */
  clips: z.array(Clip).default([]),
  muted: z.boolean().default(false),
  /** Locked tracks are excluded from LLM ops. */
  locked: z.boolean().default(false),
});
export type Track = z.infer<typeof Track>;

export const Timeline = z.object({
  id: TimelineId,
  /** Output frame rate. Sources at other rates are resampled by the renderer. */
  frameRate: RationalSchema,
  /** Output resolution. Mobile capture means this is usually portrait. */
  resolution: Resolution,
  tracks: z.array(Track).min(1),
  /** Letterbox / background colour, `#rrggbb`. */
  background: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#000000'),
});
export type Timeline = z.infer<typeof Timeline>;

/** Total output length: the furthest end of any enabled clip on any track. */
export function timelineDuration(timeline: Timeline): number {
  let max = 0;
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      if (!clip.enabled) continue;
      const end = clip.start + Math.round((clip.sourceOut - clip.sourceIn) / clip.speed);
      if (end > max) max = end;
    }
  }
  return max;
}

/** Find a clip anywhere in the timeline, with the track that holds it. */
export function findClip(
  timeline: Timeline,
  clipId: string,
): { track: Track; clip: Clip; index: number } | null {
  for (const track of timeline.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index !== -1) return { track, clip: track.clips[index]!, index };
  }
  return null;
}

export function findTrack(timeline: Timeline, trackId: string): Track | null {
  return timeline.tracks.find((t) => t.id === trackId) ?? null;
}

/** Every clip in the timeline, track order then clip order. */
export function allClips(timeline: Timeline): Clip[] {
  return timeline.tracks.flatMap((t) => t.clips);
}
