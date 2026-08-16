import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  microsToSeconds,
  secondsToMicros,
  sourceToTimeline,
  type ColorValue,
  type Timeline,
  sampleTransform,
  type Easing,
  type TransformValue,
} from '@evocut/edl';
import { filterFor, paintedSize, previewTransform, sampleTimeline, type FrameLayer } from '@evocut/renderer';
import { frameAt, useFilmstrips } from './filmstrip.ts';
import { usePlayhead } from './playhead.ts';
import {
  newScrubPace,
  noteSeekIssued,
  noteSeekLanded as pacedSeekLanded,
  shouldSeekNow,
} from './scrub.ts';

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
 * ## The stage is the output frame
 *
 * The elements do not fill the player box — they fill a *stage* inside it, sized to the
 * timeline's own aspect ratio and clipping at its edges. That is what makes a pan mean
 * anything. With the video simply filling the box under `object-fit: contain`, the picture
 * sat letterboxed inside black bars, and translating it slid the whole picture around in
 * the bars instead of moving the framing within a fixed frame: "it moves the entire frame
 * left and right in the app", which is exactly what it was doing.
 *
 * The stage is the frame the export will produce. The source covers it — the renderer's
 * `scale: 1` means cover, so anything else would make the preview and the file disagree at
 * every zoom — and slides behind it, cropped, the way `drawLayer` crops against the canvas.
 *
 * ## The proxy carries the gesture
 *
 * A seek on a multi-gigabyte 4K file costs most of a second no matter how it is paced, so
 * even a perfectly paced scrub shows about one frame per second — which is a slideshow, not
 * a scrub. What moves at sixty frames a second is the filmstrip: those frames are already
 * decoded, already in memory, and already indexed by source time because the timeline draws
 * them.
 *
 * So during a gesture the picture is a filmstrip frame, swapped on every scroll, and the
 * element seeks behind it at whatever rate it can sustain. When the gesture settles the
 * proxy goes away and the real frame is underneath. It is low resolution and it is the
 * right trade: a coarse picture that tracks your thumb tells you where you are, and a sharp
 * picture that arrives a second later does not.
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
  /**
   * The same, for framing, while the Transform panel is open.
   *
   * The whole keyframe list rather than one sampled value, because the panel no longer owns
   * the clock: the playhead moves with the real timeline underneath it, and the preview has
   * to show the framing *at the moment on screen* — which during playback is a different
   * value every frame.
   */
  previewTransform?: { clipId: string; keys: TransformKeyframes } | null;
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
/** How long a source runs, from the furthest any clip reaches into it. */
function sourceDurationOf(timeline: Timeline, sourceId: string): number {
  let furthest = 0;
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.sourceId === sourceId) furthest = Math.max(furthest, clip.sourceOut);
    }
  }
  return furthest;
}

/** What an empty draft looks like: no framing at all. */
const IDENTITY_FRAMING: TransformValue = { scale: 1, x: 0, y: 0, rotation: 0 };

/** The keyframe list the Transform panel hands over. */
type TransformKeyframes = Array<{ t: number; value: TransformValue; easing: Easing }>;

export function Player({
  objectUrl,
  timeline,
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
  const stageRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const lastResyncRef = useRef(0);

  /** Which element is on screen. The ref is what the loop reads; the state paints it. */
  const liveRef = useRef(0);
  const [live, setLive] = useState(0);
  /** Source time the spare has been aimed at, or null when it is aimed at nothing. */
  const preppedRef = useRef<number | null>(null);

  /**
   * Size the stage to the output frame, fitted inside whatever room the player has.
   *
   * In pixels, from a `ResizeObserver`, rather than in CSS. `aspect-ratio` with
   * `max-width`/`max-height` does not do this: whichever dimension is definite wins, the
   * clamp applies to the other, and the ratio never re-derives — the stage came out the
   * shape of the player box instead of the shape of the video. Measuring is exact, and the
   * measurement is needed anyway, because a pan is a fraction of this box.
   */
  useLayoutEffect(() => {
    const player = playerRef.current;
    const stage = stageRef.current;
    if (!player || !stage) return;

    const fit = () => {
      const box = player.getBoundingClientRect();
      const size = paintedSize(
        { width: box.width, height: box.height },
        { width: timeline.resolution.width, height: timeline.resolution.height },
      );
      stage.style.width = `${Math.round(size.width)}px`;
      stage.style.height = `${Math.round(size.height)}px`;
    };

    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(player);
    return () => observer.disconnect();
  }, [timeline.resolution.height, timeline.resolution.width]);

  const at = useCallback(
    (index: number) => (index === 0 ? aRef.current : bRef.current),
    [],
  );
  const liveVideo = useCallback(() => at(liveRef.current), [at]);
  const spareVideo = useCallback(() => at(1 - liveRef.current), [at]);

  // Subscribed rather than passed in: a scroll moves the playhead sixty times a second, and
  // the point of the store is that only the handful of components that need that rate pay
  // for it. This is one of them.
  const playhead = usePlayhead();

  /*
    The already-decoded frames, for the proxy.

    The same extraction the timeline's filmstrip uses — promise-cached per source, so this
    costs one subscription and no extra seeking.
  */
  const sources = useMemo(
    () =>
      timeline.tracks
        .flatMap((track) => track.clips)
        .map((clip) => clip.sourceId)
        .filter((id, index, all) => all.indexOf(id) === index)
        .map((id) => ({ id, url: objectUrl, durationUs: sourceDurationOf(timeline, id) })),
    [objectUrl, timeline],
  );
  const strips = useFilmstrips(sources);

  /**
   * The proxy frame for wherever the playhead is, or null when it is not needed.
   *
   * Only while scrubbing: the rest of the time the element itself is showing the right
   * thing at full resolution, and covering it with a thumbnail would be a downgrade.
   */
  const proxy = useMemo(() => {
    if (!scrubbing) return null;
    const layer = sampleTimeline(timeline, playhead).layers[0];
    if (!layer) return null;
    const strip = strips.get(layer.clip.sourceId);
    if (!strip) return null;
    // A trim drag overrides the playhead — the preview is showing a source time that has
    // no place on the timeline yet — so the proxy has to follow the same override, or the
    // handle would drag against a still frame of wherever the playhead happens to be.
    return frameAt(strip, scrubSourceTime ?? layer.sourceTime);
  }, [playhead, scrubbing, scrubSourceTime, strips, timeline]);
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

  /** Scrub seek pacing: one in flight, no faster than the last one took. See `scrub.ts`. */
  const paceRef = useRef(newScrubPace());

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
      framing && framing.clipId === layer.clip.id && framing.keys.length > 0
        ? sampleTransform(framing.keys, layer.clipOffset)
        : framing && framing.clipId === layer.clip.id
          ? IDENTITY_FRAMING
          : layer.transform;

    // Measured off the stage, not the element: `x` is a fraction of the *output frame*, and
    // the stage is the output frame. The element fills it, so the two agree — but reading
    // the element would start disagreeing the moment a transform scaled it.
    const stage = stageRef.current?.getBoundingClientRect();
    video.style.transform = previewTransform(transform, {
      width: stage?.width ?? 0,
      height: stage?.height ?? 0,
    });
  }, []);

  const seekTo = useCallback((video: HTMLVideoElement, sourceUs: number, approximate: boolean) => {
    if (Math.abs(secondsToMicros(video.currentTime) - sourceUs) <= SEEK_TOLERANCE_US) return;

    /*
      An approximate seek is a *scrub* seek — one of a stream of them, none of which is the
      one that decides what you end up looking at. Those are paced; the exact seek at the end
      of a gesture, and every seek playback makes, go straight through. The rule and the
      reasoning behind it are in `scrub.ts`, where they are testable.
    */
    if (approximate) {
      const now = Date.now();
      if (!shouldSeekNow(paceRef.current, now, video.seeking)) return;
      paceRef.current = noteSeekIssued(paceRef.current, now);
    }

    const seconds = Math.max(0, microsToSeconds(sourceUs));
    if (approximate && typeof video.fastSeek === 'function') video.fastSeek(seconds);
    else video.currentTime = seconds;
  }, []);

  /**
   * Learn what a seek costs on this file, and pace the next one by it.
   *
   * Measured rather than configured, because the answer is four orders of magnitude apart
   * between a phone clip and a 4K master and there is no constant that suits both.
   */
  const noteSeekLanded = useCallback(() => {
    paceRef.current = pacedSeekLanded(paceRef.current, Date.now());
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
    <div className="player" ref={playerRef}>
      {/*
        The stage is the output frame: the timeline's aspect ratio, letterboxed inside
        whatever space the player has, clipping at its own edges. Everything inside it is
        drawn the way the export draws it.

        Both elements carry the same source. The spare is not `hidden` and not
        `display: none` — a hidden element is allowed to stop decoding, which would undo
        the one thing it is here for. It is stacked behind the live one at zero opacity,
        fully alive, one frame ready to go.
      */}
      <div className="stage" ref={stageRef}>
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
          onSeeked={noteSeekLanded}
        />
        <video
          ref={bRef}
          className={live === 1 ? 'live' : 'spare'}
          src={objectUrl}
          playsInline
          preload="auto"
          onSeeked={noteSeekLanded}
        />
        {/*
          Over the top, only while a gesture is live. `key`-less and `src`-swapped so the
          browser reuses one element and one decoded bitmap rather than mounting a new
          image sixty times a second.
        */}
        {proxy && <img className="scrub-proxy" src={proxy.url} alt="" draggable={false} />}
      </div>
    </div>
  );
}
