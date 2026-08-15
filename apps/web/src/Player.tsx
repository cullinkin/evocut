import { useEffect, useRef } from 'react';
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
 * Playback across a cut is a seek, not a crossfade: the element jumps to the next clip's
 * source position when it runs off the end of the current one. That stutters slightly on
 * a phone, which is acceptable for a coarse pass whose whole purpose is deciding what to
 * keep. Gapless preview is the renderer's job, not the `<video>` element's.
 */
export interface PlayerProps {
  objectUrl: string;
  timeline: Timeline;
  playhead: number;
  playing: boolean;
  onTime(outputTime: number): void;
  onEnded(): void;
}

/** Below this, a seek is more disruptive than the drift it would correct. */
const SEEK_TOLERANCE_US = 60_000;

export function Player({ objectUrl, timeline, playhead, playing, onTime, onEnded }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<number | null>(null);
  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;

  // Follow external seeks (scrubber, clip taps) without fighting playback.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const layer = sampleTimeline(timeline, playhead).layers[0];
    if (!layer) return;

    video.playbackRate = layer.clip.speed;
    const target = microsToSeconds(layer.sourceTime);
    if (Math.abs(secondsToMicros(video.currentTime) - layer.sourceTime) > SEEK_TOLERANCE_US) {
      video.currentTime = target;
    }
  }, [playhead, timeline]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (!playing) {
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

      if (sourceNow >= layer.clip.sourceOut) {
        // Ran off the end of this clip: jump to whatever the timeline says comes next.
        const nextOutput = layer.clip.start + Math.round((layer.clip.sourceOut - layer.clip.sourceIn) / layer.clip.speed);
        const next = sampleTimeline(timeline, nextOutput).layers[0];
        if (!next) {
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
  }, [playing, timeline, onTime, onEnded]);

  return (
    <div className="player">
      <video ref={videoRef} src={objectUrl} playsInline preload="auto" />
    </div>
  );
}
