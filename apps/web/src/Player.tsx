import { useCallback, useEffect, useRef, useState } from 'react';
import {
  microsToSeconds,
  secondsToMicros,
  sourceToTimeline,
  type ColorValue,
  type Timeline,
  type TransformValue,
} from '@evocut/edl';
import { filterFor, paintedSize, previewTransform, sampleTimeline, type FrameLayer } from '@evocut/renderer';

/**
 * Preview player.
 *
 * The video element plays *source* time; the app thinks in *output* time. This component
 * is the only place that conversion happens, and it does it through the renderer's
 * `sampleTimeline` — the same function the export will use. Reimplementing the mapping
 * here would be the classic editor bug where the preview and the export disagree at cuts.
 *
 * ## Two elements, because a cut is a seek
 *
 * A cut in the timeline is a jump in the recording, and `video.currentTime = x` on a 5 GB
 * 4K file is not free: the element decodes forward from the previous keyframe, which on a
 * phone is the better part of a second. Do that at every clip boundary and playback is a
 * stutter every few seconds — you can see each shot, but never how the edit *flows*, which
 * is the one question the preview exists to answer.
 *
 * So there are two elements and only one of them is on screen. While the live one plays,
 * the spare is parked, paused, on the first frame of the next clip — it has already paid
 * for that seek, in the seconds nobody was waiting. At the boundary the live one pauses,
 * the spare plays, and the two swap places. The swap is a class change; no seek happens at
 * the cut at all.
 *
 * Three things keep it honest:
 *
 *  - **The spare must actually be there.** If it has not finished its seek, the handoff is
 *    abandoned and the live element seeks the old way. The worst case is exactly the
 *    behaviour this replaces, never a wrong frame.
 *  - **Adjacent clips are not a cut.** Two kept clips that meet where the recording meets
 *    itself — the common shape after a split — need no handoff and get none.
 *  - **Only the live element ever plays.** The spare is paused, so there is one picture and
 *    one soundtrack at all times.
 *
 * ## Seeking, and why the kind matters
 *
 * `video.currentTime = x` asks for an exact frame. Issue one of those per animation frame
 * and iOS never finishes any of them: the picture simply stops moving, which is what
 * "dragging the playhead does not scrub" looks like from the outside. `fastSeek` asks for
 * the nearest keyframe instead — approximate, and fast enough to track a finger. So every
 * seek made *during* a drag is approximate, and the exact one happens when the drag ends.
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
  /**
   * Overrides one clip's grade while the Adjust sheet is open.
   *
   * The sliders must show their effect on the picture, and writing every intermediate
   * value into the EDL would put a hundred revisions in the log on the way to one look.
   * So the sheet holds a draft, the draft comes through here, and only the value it
   * settles on is committed.
   *
   * Carries the clip id because the playhead can move while the sheet is open, and a draft
   * that leaked onto whatever clip happened to be under the playhead would be showing a
   * change that is not going to be made.
   */
  previewColor?: { clipId: string; value: ColorValue } | null;
  /** The same, for framing, while the Transform sheet is open. */
  previewTransform?: { clipId: string; value: TransformValue } | null;
  onTime(outputTime: number): void;
  onEnded(): void;
  /** Reports what the element can do with this media, once metadata has loaded. */
  onDiagnostics?(info: Record<string, unknown>): void;
}

/** Below this, a seek is more disruptive than the drift it would correct. */
const SEEK_TOLERANCE_US = 60_000;
/** How often the loop may correct an element that has drifted outside its clip. */
const RESYNC_INTERVAL_MS = 250;
/**
 * How close the spare must be to the next in-point for the handoff to be taken.
 *
 * Roughly a frame and a half. Tighter than this and a keyframe-aligned seek would be
 * rejected on media whose keyframes are sparse; looser and the cut lands visibly early.
 */
const HANDOFF_TOLERANCE_US = 60_000;
/**
 * Two clips whose join is this close in the source are the recording continuing.
 *
 * A split leaves exactly this shape — one shot, cut in two, both halves kept — and there is
 * nothing to hand over: the element is already playing the frames the next clip wants.
 */
const CONTIGUOUS_US = 20_000;
/**
 * Floor on how often a *scrub* may re-aim the element.
 *
 * A scroll gesture with momentum emits events for as long as it coasts, and each one used
 * to issue a seek. On the twelve-second test clip that is free; on a 5 GB 4K recording it
 * is a queue of seeks that never drains, and an element that never completes one shows
 * nothing at all — the black picture reported from a real project, which looked for all
 * the world like the preview had stopped following the edit.
 *
 * Six a second is faster than anyone can read a frame and slow enough that each one
 * finishes. The seek at the *end* of a gesture is exempt: it is exact, it is the one that
 * decides what you are looking at, and there is only ever one of it.
 */
const SCRUB_SEEK_INTERVAL_MS = 160;

export function Player({
  objectUrl,
  timeline,
  playhead,
  playing,
  scrubbing = false,
  scrubSourceTime = null,
  previewColor = null,
  previewTransform: transformDraft = null,
  onTime,
  onEnded,
  onDiagnostics,
}: PlayerProps) {
  const aRef = useRef<HTMLVideoElement>(null);
  const bRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<number | null>(null);
  const lastResyncRef = useRef(0);

  /** Which element is on screen. The ref is what the loop reads; the state paints it. */
  const liveRef = useRef(0);
  const [live, setLive] = useState(0);
  /** Source time the spare has been aimed at, or null when it is aimed at nothing. */
  const preppedRef = useRef<number | null>(null);

  const at = useCallback(
    (index: number) => (index === 0 ? aRef.current : bRef.current),
    [],
  );
  const liveVideo = useCallback(() => at(liveRef.current), [at]);
  const spareVideo = useCallback(() => at(1 - liveRef.current), [at]);

  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;
  const scrubRef = useRef<number | null>(scrubSourceTime);
  scrubRef.current = scrubSourceTime;
  const scrubbingRef = useRef(scrubbing);
  scrubbingRef.current = scrubbing;
  const previewColorRef = useRef(previewColor);
  previewColorRef.current = previewColor;
  const transformDraftRef = useRef(transformDraft);
  transformDraftRef.current = transformDraft;

  // Held in refs so the playback effect does not depend on them. The session hook returns
  // a fresh object every render, so a callback in the dependency list tore the loop down
  // and called `play()` again on every single frame.
  const onTimeRef = useRef(onTime);
  onTimeRef.current = onTime;
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  const onDiagnosticsRef = useRef(onDiagnostics);
  onDiagnosticsRef.current = onDiagnostics;
  const reportedForRef = useRef<string | null>(null);

  const lastScrubSeekRef = useRef(0);

  /**
   * Put the grade and the framing on an element.
   *
   * Both come from the renderer's own functions, so what is on screen is produced by the
   * same code as what will be in the file. The drafts are consulted here because that is
   * the one place they can be applied to whichever element happens to be live.
   */
  const dress = useCallback((video: HTMLVideoElement, layer: FrameLayer) => {
    const colour = previewColorRef.current;
    video.style.filter = filterFor(
      colour && colour.clipId === layer.clip.id ? colour.value : layer.color,
    );

    const framing = transformDraftRef.current;
    const transform =
      framing && framing.clipId === layer.clip.id ? framing.value : layer.transform;
    const box = video.getBoundingClientRect();
    video.style.transform = previewTransform(
      transform,
      paintedSize(
        { width: box.width, height: box.height },
        { width: video.videoWidth, height: video.videoHeight },
      ),
    );
  }, []);

  const seekTo = useCallback((video: HTMLVideoElement, sourceUs: number, approximate: boolean) => {
    if (Math.abs(secondsToMicros(video.currentTime) - sourceUs) <= SEEK_TOLERANCE_US) return;

    if (approximate) {
      // Rate-limited, and dropped rather than queued: the next scroll event is a fraction
      // of a second away and carries a better answer, so a skipped one costs nothing.
      const now = Date.now();
      if (now - lastScrubSeekRef.current < SCRUB_SEEK_INTERVAL_MS) return;
      lastScrubSeekRef.current = now;
    }

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
    const video = liveVideo();
    if (!video) return;

    const scrub = scrubRef.current;
    if (scrub !== null) {
      seekTo(video, scrub, true);
      return;
    }

    const layer = sampleTimeline(timeline, playheadRef.current).layers[0];
    if (!layer) return;
    video.playbackRate = layer.clip.speed;
    // The same string the export sets on its canvas — one function, two surfaces, so the
    // graded preview is evidence about the graded file rather than a second opinion.
    dress(video, layer);
    seekTo(video, layer.sourceTime, scrubbingRef.current);
  }, [dress, liveVideo, seekTo, timeline]);

  useEffect(sync, [sync, playhead, scrubSourceTime, scrubbing, previewColor, transformDraft]);

  /**
   * Park the spare on the first frame of whatever plays at `outputUs`.
   *
   * Idempotent, so the loop can call it every frame: once the spare is aimed at the right
   * source time it does nothing, and re-issuing the seek would restart it.
   */
  const prepare = useCallback(
    (outputUs: number) => {
      const spare = spareVideo();
      if (!spare) return;
      const next = sampleTimeline(timeline, outputUs).layers[0];
      if (!next) return;
      if (
        preppedRef.current !== null &&
        Math.abs(preppedRef.current - next.sourceTime) <= HANDOFF_TOLERANCE_US
      ) {
        return;
      }
      preppedRef.current = next.sourceTime;
      spare.playbackRate = next.clip.speed;
      // Dressed before it is shown. The handoff is a swap of two live elements, so a spare
      // still wearing the outgoing clip's look would flash it for a frame at every cut.
      dress(spare, next);
      spare.currentTime = Math.max(0, microsToSeconds(next.sourceTime));
    },
    [dress, spareVideo, timeline],
  );

  // A changed timeline invalidates whatever the spare was holding: accepting a suggestion
  // can move the very cut it was prepared for.
  useEffect(() => {
    preppedRef.current = null;
  }, [timeline]);

  /**
   * Once metadata is in, say whether this element can seek at all.
   *
   * `seekable.length === 0` is the definitive form of the iOS blob-URL failure: the media
   * loads, reports a duration, plays — and every `currentTime` assignment is ignored. From
   * the outside that is indistinguishable from an editor whose cuts do nothing, so it is
   * worth stating plainly rather than inferring from behaviour.
   */
  const reportDiagnostics = useCallback(() => {
    const video = liveVideo();
    if (!video || reportedForRef.current === objectUrl) return;
    reportedForRef.current = objectUrl;

    const ranges = video.seekable;
    onDiagnosticsRef.current?.({
      seekable: ranges.length > 0,
      seekableRanges: ranges.length,
      seekableEnd: ranges.length > 0 ? Number(ranges.end(ranges.length - 1).toFixed(3)) : 0,
      duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(3)) : null,
      readyState: video.readyState,
      urlScheme: objectUrl.startsWith('blob:') ? 'blob' : 'http',
      fastSeek: typeof video.fastSeek === 'function',
    });
  }, [liveVideo, objectUrl]);

  useEffect(() => {
    const video = liveVideo();
    if (!video) return;

    // A drag owns the element for its duration. Letting the playback loop keep writing
    // the playhead from `currentTime` is what made dragging the playhead look like it did
    // nothing: every frame, the loop put it back.
    if (!playing || scrubbing) {
      video.pause();
      spareVideo()?.pause();
      return;
    }

    void video.play().catch(() => {
      // Autoplay can be refused until the user has interacted with the page. The
      // transport button is that interaction, so a refusal here is not worth surfacing.
    });

    const tick = () => {
      frameRef.current = requestAnimationFrame(tick);

      const current = liveVideo();
      if (!current) return;

      const layer = sampleTimeline(timeline, playheadRef.current).layers[0];
      if (!layer) {
        onEndedRef.current();
        return;
      }

      const sourceNow = secondsToMicros(current.currentTime);
      const endOutput =
        layer.clip.start + Math.round((layer.clip.sourceOut - layer.clip.sourceIn) / layer.clip.speed);

      // `video.ended` matters as much as the clip's own out point: a clip trimmed to the
      // very end of the source never reaches `sourceOut`, because the element stops a
      // fraction short. Without this the playhead parks mid-timeline and looks stuck.
      if (sourceNow >= layer.clip.sourceOut || current.ended) {
        const next = sampleTimeline(timeline, endOutput).layers[0];
        if (!next) {
          onTimeRef.current(endOutput);
          onEndedRef.current();
          return;
        }

        // The recording simply continues into the next clip — no jump, so no handoff.
        const continues =
          !current.ended &&
          next.clip.sourceId === layer.clip.sourceId &&
          next.clip.speed === layer.clip.speed &&
          Math.abs(next.sourceTime - layer.clip.sourceOut) <= CONTIGUOUS_US;

        if (!continues) {
          const spare = spareVideo();
          const armed =
            spare !== null &&
            spare.readyState >= 2 &&
            !spare.seeking &&
            Math.abs(secondsToMicros(spare.currentTime) - next.sourceTime) <= HANDOFF_TOLERANCE_US;

          if (armed && spare) {
            spare.playbackRate = next.clip.speed;
            void spare.play().catch(() => {});
            current.pause();
            liveRef.current = 1 - liveRef.current;
            setLive(liveRef.current);
          } else {
            // Nothing prepared in time. This is the old behaviour, and it is correct —
            // just slow, which is the whole reason the spare exists.
            current.currentTime = microsToSeconds(next.sourceTime);
            current.playbackRate = next.clip.speed;
          }
          preppedRef.current = null;
        }

        onTimeRef.current(endOutput);
        return;
      }

      // A keyframed push-in moves every frame, so the live element is re-dressed as it
      // plays rather than only when the clip changes. Setting an unchanged style string is
      // free; not setting it means the preview shows the framing the shot started on.
      dress(current, layer);

      // Pay for the next cut's seek now, while there is time to spare.
      prepare(endOutput);

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
        current.currentTime = microsToSeconds(layer.sourceTime);
      }
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [dress, liveVideo, playing, prepare, scrubbing, spareVideo, timeline]);

  return (
    <div className="player">
      {/*
        Both elements carry the same source. The spare is not `hidden` and not
        `display: none` — a hidden element is allowed to stop decoding, which would undo
        the one thing it is here for. It is stacked behind the live one at zero opacity,
        fully alive, one frame ready to go.
      */}
      <video
        ref={aRef}
        className={live === 0 ? 'live' : 'spare'}
        src={objectUrl}
        playsInline
        preload="auto"
        onLoadedMetadata={() => {
          sync();
          reportDiagnostics();
        }}
      />
      <video ref={bRef} className={live === 1 ? 'live' : 'spare'} src={objectUrl} playsInline preload="auto" />
    </div>
  );
}
