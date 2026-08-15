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
 * ## Scrubbing
 *
 * `scrubSourceTime` overrides everything while a drag is live: show *this* frame of the
 * source, now. A trim is a decision about one frame and cannot be made without seeing it,
 * and routing that through the timeline mapping would mean re-deriving a timeline that is
 * deliberately not being modified until the drag ends.
 *
 * Scrub seeks go through `fastSeek` where it exists. Safari implements it precisely for
 * this — it lands on the nearest keyframe instead of decoding to an exact position, which
 * is the difference between a preview that tracks a finger and one that lurches a second
 * behind it. The final, exact seek happens when the drag ends.
 *
 * Playback across a cut is a seek, not a crossfade: the element jumps to the next clip's
 * source position when it runs off the end of the current one. That stutters slightly on a
 * phone, which is acceptable for a coarse pass whose whole purpose is deciding what to
 * keep. Gapless preview is the renderer's job, not the `<video>` element's.
 */
export interface PlayerProps {
  objectUrl: string;
  timeline: Timeline;
  playhead: number;
  playing: boolean;
  /** While set, the preview shows this source time and playback logic stands down. */
  scrubSourceTime?: number | null;
  onTime(outputTime: number): void;
  onEnded(): void;
}

/** Below this, a seek is more disruptive than the drift it would correct. */
const SEEK_TOLERANCE_US = 60_000;

export function Player({
  objectUrl,
  timeline,
  playhead,
  playing,
  scrubSourceTime = null,
  onTime,
  onEnded,
}: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<number | null>(null);
  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;
  const scrubRef = useRef<number | null>(scrubSourceTime);
  scrubRef.current = scrubSourceTime;

  const seekTo = useCallback((video: HTMLVideoElement, sourceUs: number, approximate: boolean) => {
    if (Math.abs(secondsToMicros(video.currentTime) - sourceUs) <= SEEK_TOLERANCE_US) return;
    const seconds = microsToSeconds(sourceUs);
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
    seekTo(video, layer.sourceTime, false);
  }, [seekTo, timeline]);

  useEffect(sync, [sync, playhead, scrubSourceTime]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // A drag owns the element for its duration. Letting the playback loop keep writing
    // the playhead from `currentTime` is what made dragging the playhead look like it did
    // nothing: every frame, the loop put it back.
    if (!playing || scrubSourceTime !== null) {
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
        onEnded();
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
          onTime(nextOutput);
          onEnded();
          return;
        }
        video.currentTime = microsToSeconds(next.sourceTime);
        video.playbackRate = next.clip.speed;
        onTime(nextOutput);
        return;
      }

      const output = sourceToTimeline(layer.clip, sourceNow);
      if (output !== null) onTime(output);
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [playing, scrubSourceTime, timeline, onTime, onEnded]);

  return (
    <div className="player">
      <video ref={videoRef} src={objectUrl} playsInline preload="auto" onLoadedMetadata={sync} />
    </div>
  );
}
