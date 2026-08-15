import type { Clip } from './schema/clip.js';
import { outputDuration } from './schema/clip.js';
import type { Timeline, Track } from './schema/timeline.js';
import { snapToFrame, type Rational } from './time.js';

/**
 * Recompute derived timeline state.
 *
 * The invariant this establishes: on a `video` track, clips are contiguous and in playback
 * order, so `clip.start` is fully determined by the clips before it. Delete a clip and the
 * rest ripple left — which is exactly the mental model of the coarse pass, where the user
 * is throwing away bad takes and expects the video to get shorter.
 *
 * `audio` and `overlay` tracks keep their explicit `start` (music does not ripple when you
 * cut a take) and are only sorted.
 *
 * Call this after every mutation. `applyOps` already does.
 */
export function normalizeTimeline(timeline: Timeline): Timeline {
  return {
    ...timeline,
    tracks: timeline.tracks.map(normalizeTrack),
  };
}

export function normalizeTrack(track: Track): Track {
  // A clip with no duration renders nothing and breaks the sourceIn < sourceOut
  // invariant every consumer relies on. These only appear from a bad split or a
  // trim past the opposite edge, so dropping them here keeps the damage local.
  const clips = track.clips.filter((clip) => clip.sourceOut > clip.sourceIn);

  if (track.kind !== 'video') {
    const sorted = [...clips].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    return { ...track, clips: sorted };
  }

  let cursor = 0;
  const reflowed = clips.map((clip) => {
    const placed: Clip = clip.start === cursor ? clip : { ...clip, start: cursor };
    // Disabled clips are skipped by the render, so they must not occupy output time
    // either — otherwise toggling one off would leave a gap of black.
    if (clip.enabled) cursor += outputDuration(clip);
    return placed;
  });

  return { ...track, clips: reflowed };
}

/**
 * Snap every cut point to a frame boundary of the output rate.
 *
 * Kept out of `normalizeTimeline` on purpose. A cut the user made by dragging on a phone
 * lands between frames, and that sub-frame position is real signal for the training set;
 * we only want the rounded version at render time. So: log the gesture, snap at the end.
 */
export function snapTimelineToFrames(timeline: Timeline, rate: Rational = timeline.frameRate): Timeline {
  return normalizeTimeline({
    ...timeline,
    tracks: timeline.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => {
        const sourceIn = snapToFrame(clip.sourceIn, rate, 'nearest');
        let sourceOut = snapToFrame(clip.sourceOut, rate, 'nearest');
        // Never let rounding collapse a short clip to nothing.
        if (sourceOut <= sourceIn) sourceOut = snapToFrame(clip.sourceIn, rate, 'ceil') + frameStep(rate);
        return { ...clip, sourceIn, sourceOut, start: snapToFrame(clip.start, rate, 'nearest') };
      }),
    })),
  });
}

function frameStep(rate: Rational): number {
  return Math.round((1_000_000 * rate.den) / rate.num);
}

/**
 * The regions of a source the timeline does *not* use.
 *
 * This is the other half of the training pair. The EDL records what the human kept; the
 * label we actually want to learn is "keep or drop" over the whole recording, and that
 * needs the complement.
 */
export function droppedRegions(
  timeline: Timeline,
  sourceId: string,
  sourceDurationUs: number,
): Array<{ start: number; end: number }> {
  const used = timeline.tracks
    .flatMap((t) => t.clips)
    .filter((c) => c.sourceId === sourceId && c.enabled)
    .map((c) => ({ start: c.sourceIn, end: c.sourceOut }))
    .sort((a, b) => a.start - b.start);

  const gaps: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const region of used) {
    if (region.start > cursor) gaps.push({ start: cursor, end: region.start });
    cursor = Math.max(cursor, region.end);
  }
  if (cursor < sourceDurationUs) gaps.push({ start: cursor, end: sourceDurationUs });
  return gaps;
}
