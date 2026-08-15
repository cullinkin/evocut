import { useCallback, useEffect, useRef } from 'react';
import { microsToSeconds, secondsToMicros, sourceToTimeline, type Timeline } from '@evocut/edl';
import { sampleTimeline } from '@evocut/renderer';

/**
 * Preview player.
 *
 * The video element plays *source* time; the app thinks in *output* time. This component
 * is the only place that conversion happens, and it does it through the renderer's
 * `sampleTimeline` — the same function the export will use. Reimplementing the mapping
 * here would be the classic editor bug where the preview and the export disagree at cuts.
 *
 * ## Seeking, and why the kind matters
 *
 * `video.currentTime = x` asks for an exact frame, which means decoding forward from the
 * previous keyframe. Issue one of those per animation frame and iOS never finishes any of
 * them: the picture simply stops moving, which is what "dragging the playhead does not
 * scrub" looks like from the outside. `fastSeek` asks for the nearest keyframe instead —
 * approximate, and fast enough to track a finger. So every seek made *during* a drag is
 * approximate, and the exact one happens when the drag ends.
 *
 * ## The loop corrects itself
 *
 * `sourceToTimeline` returns null when the element is playing from outside the current
 * clip's range — after a seek that never landed, say. The loop used to take that as
 * "nothing to report" and simply stop moving the playhead, while the video played on
 * underneath. Now it treats it as drift and puts the element back where the timeline says
 * it should be.
 */
export interface PlayerProps {
  objectUrl: string;
  timeline: Timeline;
  playhead: number;
  playing: boolean;
  /** True while any drag is live: seeks go approximate and playback stands down. */
  scrubbing?: boolean;
  /** While set, the preview shows this source time instead of following the playhead. */
  scrubSourceTime?: number | null;
  onTime(outputTime: number): void;
  onEnded(): void;
}

/** Below this, a seek is more disruptive than the drift it would correct. */
const SEEK_TOLERANCE_US = 60_000;
/** How often the loop may correct an element that has drifted outside its clip. */
const RESYNC_INTERVAL_MS = 250;

export function Player({
  objectUrl,
  timeline,
  playhead,
  playing,
  scrubbing = false,
  scrubSourceTime = null,
  onTime,
  onEnded,
}: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<number | null>(null);
  const lastResyncRef = useRef(0);

  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;
  const scrubRef = useRef<number | null>(scrubSourceTime);
  scrubRef.current = scrubSourceTime;
  const scrubbingRef = useRef(scrubbing);
  scrubbingRef.current = scrubbing;

  // Held in refs so the playback effect does not depend on them. The session hook returns
  // a fresh object every render, so a callback in the dependency list tore the loop down
  // and called `play()` again on every single frame.
  const onTimeRef = useRef(onTime);
  onTimeRef.current = onTime;
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  const seekTo = useCallback((video: HTMLVideoElement, sourceUs: number, approximate: boolean) => {
    if (Math.abs(secondsToMicros(video.currentTime) - sourceUs) <= SEEK_TOLERANCE_US) return;
    const seconds = Math.max(0, microsToSeconds(sourceUs));
    if (approximate && typeof video.fastSeek === 'function') video.fastSeek(seconds);
    else video.currentTime = seconds;
  }, []);

  /**
   * Put the element where the timeline says it should be.
   *
   * Also runs on `loadedmetadata`, which matters after a reload: a restored project can
   * open on a clip that starts well into the source, and a `currentTime` assignment made
   * before the element has metadata is silently discarded — leaving a black frame until
   * the user happens to scrub.
   */
  const sync = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    const scrub = scrubRef.current;
    if (scrub !== null) {
      seekTo(video, scrub, true);
      return;
    }

    const layer = sampleTimeline(timeline, playheadRef.current).layers[0];
    if (!layer) return;
    video.playbackRate = layer.clip.speed;
    seekTo(video, layer.sourceTime, scrubbingRef.current);
  }, [seekTo, timeline]);

  useEffect(sync, [sync, playhead, scrubSourceTime, scrubbing]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // A drag owns the element for its duration. Letting the playback loop keep writing
    // the playhead from `currentTime` is what made dragging the playhead look like it did
    // nothing: every frame, the loop put it back.
    if (!playing || scrubbing) {
      video.pause();
      return;
    }

    void video.play().catch(() => {
      // Autoplay can be refused until the user has interacted with the page. The
      // transport button is that interaction, so a refusal here is not worth surfacing.
    });

    const tick = () => {
      frameRef.current = requestAnimationFrame(tick);

      const layer = sampleTimeline(timeline, playheadRef.current).layers[0];
      if (!layer) {
        onEndedRef.current();
        return;
      }

      const sourceNow = secondsToMicros(video.currentTime);

      // `video.ended` matters as much as the clip's own out point: a clip trimmed to the
      // very end of the source never reaches `sourceOut`, because the element stops a
      // fraction short. Without this the playhead parks mid-timeline and looks stuck.
      if (sourceNow >= layer.clip.sourceOut || video.ended) {
        const nextOutput =
          layer.clip.start + Math.round((layer.clip.sourceOut - layer.clip.sourceIn) / layer.clip.speed);
        const next = sampleTimeline(timeline, nextOutput).layers[0];
        if (!next) {
          onTimeRef.current(nextOutput);
          onEndedRef.current();
          return;
        }
        video.currentTime = microsToSeconds(next.sourceTime);
        video.playbackRate = next.clip.speed;
        onTimeRef.current(nextOutput);
        return;
      }

      const output = sourceToTimeline(layer.clip, sourceNow);
      if (output !== null) {
        onTimeRef.current(output);
        return;
      }

      // Playing from before this clip's in point — a seek that never landed, or media
      // that resumed where it left off. Correct it, rate-limited so a seek in flight is
      // not cancelled by the next frame's attempt.
      const now = Date.now();
      if (now - lastResyncRef.current > RESYNC_INTERVAL_MS) {
        lastResyncRef.current = now;
        video.currentTime = microsToSeconds(layer.sourceTime);
      }
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [playing, scrubbing, timeline]);

  return (
    <div className="player">
      <video ref={videoRef} src={objectUrl} playsInline preload="auto" onLoadedMetadata={sync} />
    </div>
  );
}
