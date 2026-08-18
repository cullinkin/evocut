import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clipEnd,
  formatTimecode,
  outputDuration,
  timelineDuration,
  trimBounds,
  type Clip,
  type Source,
  type Timeline as TimelineDoc,
  type TrimBounds,
} from '@evocut/edl';
import type { OpPreview } from '@evocut/edl';
import type { SourceSignals } from '@evocut/signals';
import { frameAt, frameSpacingUs, thumbnailSlots, useFilmstrips, type Filmstrip } from './filmstrip.ts';
import { usePlayhead } from './playhead.ts';
import { planRuler } from './ruler.ts';
import { waveColumns, type WaveClip, type WaveSource } from './waveform.ts';

/**
 * The editing timeline: draggable playhead, tap-to-select clips, drag-the-edges trimming.
 *
 * ## A trim drag does not touch the timeline until it ends
 *
 * The first version applied a `trim` op on every pointermove and re-rendered from the
 * result. That produced a genuine runaway: the reflowed clip changed the content width,
 * which changed the scroll range, which changed the time under a *stationary* finger,
 * which trimmed further. Holding a finger near the screen edge for a second was enough to
 * collapse a four-second clip to the hundred-millisecond minimum on its own.
 *
 * So a drag now moves nothing. It carries a draft, the dragged clip is *drawn* from that
 * draft, and exactly one op is committed on release. Nothing the drag does can feed back
 * into the measurement it depends on, and the phone stops cloning the whole timeline sixty
 * times a second.
 *
 * ## The dragged edge follows the finger
 *
 * On a gapless track a clip's `start` is pinned by whatever precedes it, so trimming the
 * head really changes the clip's *length* — the left edge cannot move and the right edge
 * does. Correct, and unreadable: you drag left and the far end of the clip moves.
 *
 * While dragging, the clip is therefore drawn with the *opposite* edge pinned, so the edge
 * under your finger is the edge that moves. On release the track ripples closed in one
 * step. This is what every editor with a gapless timeline does, and it is the only version
 * where the gesture means what it looks like it means.
 *
 * ## Scrolling *is* scrubbing
 *
 * The playhead does not move. It is painted down the middle of the viewport and stays
 * there; dragging the lane moves the *footage* past it, and the time under it is read
 * straight out of `scrollLeft`. This is how every phone editor behaves, and the reason is
 * not fashion: a playhead you have to chase is a playhead you have to aim at, and aiming
 * at a two-pixel line with a thumb on a moving surface is the worst gesture in a mobile
 * editor. Here the aiming is done by the scroll, which is inertial, interruptible, and
 * already the most practised gesture on the device.
 *
 * It also means the browser does the work. No pointer capture, no autoscroll loop, no
 * rubber-banding at the edges — native momentum scrolling, for free, at sixty frames a
 * second on a phone that would struggle to do it in JavaScript.
 *
 * The one hazard is the feedback loop: playback moves the playhead, which scrolls the
 * lane, which fires a scroll event, which would move the playhead. It is broken by asking
 * whether a hand was on the element — see `handRef` — rather than by trying to recognise
 * our own scrolls after the fact, which is a guess that fails exactly when it matters.
 *
 * ## Touch
 *
 * Pointer Events with `setPointerCapture` for trims, so a drag keeps receiving moves after
 * the finger leaves the element it started on. `touch-action: pan-x` on the lane so it
 * scrolls; `none` on the handles so a trim is a trim. Handles hit-test at 44px around a
 * 12px paint, because a thumb is ~9mm and a trim handle cannot be.
 */
export interface TimelineDragState {
  kind: 'playhead' | 'trim';
  /** Source time the preview should show while dragging. */
  scrubSourceTime?: number;
}

export interface TimelineProps {
  timeline: TimelineDoc;
  sources: Source[];
  mediaUrls: Map<string, string>;
  selectedClipId: string | null;
  /**
   * Framing keyframes being drafted right now, if the Transform panel is open.
   *
   * Passed in rather than read off the clip, because the whole point of a draft is that it
   * is not on the clip yet — and a keyframe you have just dropped has to appear on the
   * timeline immediately or you cannot tell whether it landed.
   */
  draftKeys?: { clipId: string; keys: Array<{ t: number }> } | null;
  /**
   * What each source sounds like, for the audio lane.
   *
   * Straight from the signals pass, which measures it anyway to find the hits and the dead
   * air — so the waveform costs a read of a cached array rather than a decode. Sources
   * still being measured, or whose audio could not be read, are simply absent and draw
   * nothing.
   */
  signals: Map<string, SourceSignals>;
  /** Open suggestions, drawn as bubbles over the clips they touch. */
  previews: OpPreview[];
  accepted: boolean[];
  onSeek(us: number, final: boolean): void;
  onSelect(clipId: string | null): void;
  onTrimCommit(clipId: string, sourceIn: number, sourceOut: number): void;
  onDragChange(drag: TimelineDragState | null): void;
  onOpenSuggestion(index: number): void;
}

const MIN_PPS = 4;
/**
 * How little of the edit may fill the screen at maximum zoom.
 *
 * A third of a second, which at 30fps is ten frames across a phone — close enough that each
 * one is a finger's width apart and you can put a cut on the one you meant. Derived from the
 * viewport rather than fixed, because "a third of a second on screen" is a statement about
 * the screen: the old flat 400px-per-second ceiling was about one second on a phone and
 * about a third of one on a desktop, for no reason anybody chose.
 */
const MIN_VISIBLE_SECONDS = 1 / 3;
/** Floor under the derived ceiling, for a viewport too narrow to have measured yet. */
const MAX_PPS_FLOOR = 400;
/** How far a finger may travel and still have meant a tap. */
const TAP_SLOP_PX = 8;
/** Bubbles closer together than this are drawn as one, with a count. */
const BUBBLE_CLUSTER_PX = 30;

interface TrimDraft {
  clipId: string;
  edge: 'in' | 'out';
  sourceIn: number;
  sourceOut: number;
  /** True when the drag is pressed against a limit, so the handle can say so. */
  clamped: boolean;
}

type DragKind =
  | {
      type: 'trim';
      clipId: string;
      edge: 'in' | 'out';
      /** Timeline time under the finger at pointerdown, so the edge never jumps to it. */
      grabTime: number;
      originIn: number;
      originOut: number;
      originStart: number;
      speed: number;
      bounds: TrimBounds;
    };

export function TimelineEditor({
  timeline,
  sources,
  mediaUrls,
  selectedClipId,
  draftKeys = null,
  signals,
  previews,
  accepted,
  onSeek,
  onSelect,
  onTrimCommit,
  onDragChange,
  onOpenSuggestion,
}: TimelineProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [pxPerSecond, setPxPerSecond] = useState(40);
  const [drag, setDrag] = useState<DragKind | null>(null);
  const [draft, setDraft] = useState<TrimDraft | null>(null);
  const dragRef = useRef<DragKind | null>(null);
  const draftRef = useRef<TrimDraft | null>(null);
  /** True from the first scroll event of a gesture until 140ms after the last one. */
  const scrubbingRef = useRef(false);
  const scrubTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The last time we announced, so a sub-pixel scroll does not re-render the editor. */
  const lastScrubRef = useRef<number | null>(null);
  /** The pending animation frame that will announce the scroll, if one is already booked. */
  const rafRef = useRef<number | null>(null);
  const announcedRef = useRef<number | null>(null);
  /** Half the viewport: the padding that lets time zero sit under a centred playhead. */
  const [halfWidth, setHalfWidth] = useState(0);
  /**
   * How we tell the user's scrolls from our own.
   *
   * By asking whether a hand was involved, rather than by inspecting where the scroll
   * landed. The first version compared `scrollLeft` against the position we had just
   * asked for and called anything else a gesture — which is a guess, and it guesses wrong
   * exactly when it matters. Playback scrolls the lane every frame; a scroll that gets
   * clamped at either end, lands on a fractional device pixel, or coalesces with the next
   * one reads as a finger that was never there. The consequences were the whole of the
   * second bug reported from a real session: playback pauses itself, the player drops into
   * scrub mode, the settle timer is pushed out by the *next* playback scroll, and the
   * thing sits there frozen until something else disturbs it.
   *
   * A pointer or a wheel on the scroller is unambiguous and cannot be faked by our own
   * `scrollTo`. Every scroll without one is ours, and is ignored outright.
   */
  const handRef = useRef(false);
  const noteHand = useCallback(() => {
    handRef.current = true;
  }, []);

  // Subscribed rather than passed in. The lane is one of the four things that genuinely
  // needs the playhead at 60Hz; the rest of the app is not, and used to render anyway.
  const playhead = usePlayhead();

  const clips = timeline.tracks[0]?.clips ?? [];
  const committedTotal = timelineDuration(timeline);

  /*
    One subscription for the whole lane, rather than one inside each clip block.

    Fifty-one blocks each holding their own `useFilmstrip` meant fifty-one pieces of state
    that changed together and fifty-one components that could not be memoised — so every
    playhead change re-rendered all of them, and a scroll is sixty playhead changes a
    second. Hoisted, the blocks become pure functions of their props and a scroll stops
    touching them at all.
  */
  const strips = useFilmstrips(
    useMemo(
      () =>
        sources.map((source) => ({
          id: source.id,
          url: mediaUrls.get(source.id) ?? null,
          durationUs: source.duration,
        })),
      [sources, mediaUrls],
    ),
  );
  // Read inside callbacks that must not re-create themselves on every playhead change.
  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;

  const toX = useCallback((us: number) => (us / 1_000_000) * pxPerSecond + halfWidth, [halfWidth, pxPerSecond]);

  const toTime = useCallback(
    (clientX: number) => {
      const scroller = scrollerRef.current;
      if (!scroller) return 0;
      const rect = scroller.getBoundingClientRect();
      const x = clientX - rect.left + scroller.scrollLeft - halfWidth;
      return Math.max(0, Math.round((x / pxPerSecond) * 1_000_000));
    },
    [halfWidth, pxPerSecond],
  );

  /** Geometry of a clip in content pixels, accounting for a drag in progress. */
  const geometryOf = useCallback(
    (clip: Clip): { left: number; width: number } => {
      const normal = {
        left: toX(clip.start),
        width: Math.max(6, (outputDuration(clip) / 1_000_000) * pxPerSecond),
      };
      if (!draft || draft.clipId !== clip.id) return normal;

      const length = (draft.sourceOut - draft.sourceIn) / clip.speed;
      const width = Math.max(6, (length / 1_000_000) * pxPerSecond);
      // The pinned edge is the one the finger is *not* holding.
      return draft.edge === 'in'
        ? { left: toX(clipEnd(clip)) - width, width }
        : { left: toX(clip.start), width };
    },
    [draft, pxPerSecond, toX],
  );

  // Half a viewport of padding at each end, so the first and last frame can both reach
  // the middle of the screen. Measured rather than guessed: it is the term that ties
  // `scrollLeft` to a time, and a stale value would put the playhead off the beat.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const measure = () => setHalfWidth(scroller.clientWidth / 2);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  /** As far in as the zoom goes: a third of a second across whatever screen this is. */
  const maxPps = Math.max(MAX_PPS_FLOOR, (halfWidth * 2) / MIN_VISIBLE_SECONDS);

  // Wide enough for a drag that has pushed a clip past the committed end.
  const contentWidth = Math.max(
    (committedTotal / 1_000_000) * pxPerSecond + halfWidth * 2,
    ...clips.map((clip) => geometryOf(clip).left + geometryOf(clip).width + halfWidth),
  );

  const fit = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller || committedTotal <= 0) return;
    const usable = Math.max(120, scroller.clientWidth - 32);
    const next = clamp(usable / (committedTotal / 1_000_000), MIN_PPS, maxPps);
    setPxPerSecond(next);
    // `scrollLeft` survives a scale change in pixels, which means it changes in *seconds*.
    // Re-anchoring keeps the playhead on the frame it was on instead of sliding it by the
    // ratio of the two zooms — and, without this, the scroll that follows reads as a
    // gesture nobody made.
    requestAnimationFrame(() => {
      scroller.scrollLeft = Math.max(0, Math.round((playheadRef.current / 1_000_000) * next));
    });
  }, [committedTotal, maxPps]);

  const fittedRef = useRef(false);
  useEffect(() => {
    if (fittedRef.current || committedTotal <= 0) return;
    fittedRef.current = true;
    fit();
  }, [fit, committedTotal]);

  /** Park the lane so `us` sits under the centred playhead, without calling it a scrub. */
  const scrollToTime = useCallback(
    (us: number, smooth = false) => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const target = Math.max(0, Math.round((us / 1_000_000) * pxPerSecond));
      if (Math.abs(scroller.scrollLeft - target) < 1) return;
      scroller.scrollTo({ left: target, behavior: smooth ? 'smooth' : 'auto' });
    },
    [pxPerSecond],
  );

  /**
   * The playhead moving from anywhere else brings the lane with it.
   *
   * Two exemptions, and the second one is a bug fix with a story. Scrolling seeks, seeking
   * moves the playhead, and this effect scrolls the lane to the playhead — a ring that is
   * only safe while the two halves cannot both be live.
   *
   * With momentum they can. The finger has let go, the lane is still travelling, and this
   * effect fires on a playhead value computed three frames ago and hauls the lane back
   * there — cancelling the coast, emitting another scroll, and asking the player to seek a
   * multi-gigabyte file again on the way. On a desktop wheel, where a scroll is one
   * instantaneous jump, it is invisible. On a phone it means the timeline barely moves
   * from where you started and the preview never finishes a seek, which is what "no matter
   * where I drag it plays from the beginning, and the picture is black" actually was.
   *
   * So while the user owns the scroller, the scroller is theirs. `scrubbingRef` is read at
   * run time rather than being a dependency because the effect is already re-running on
   * every playhead change — which, during a scrub, is exactly the run that must do nothing.
   */
  useEffect(() => {
    if (drag || scrubbingRef.current) return;
    scrollToTime(playhead);
  }, [drag, playhead, scrollToTime]);

  /**
   * Scrolling the lane is scrubbing.
   *
   * `final: false` while the finger is down, so the log records the attention trail as a
   * scrub rather than sixty seeks — and a settle timer fires the final one, because a
   * touch scroll with momentum has no event that means "stopped".
   */
  const onScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    // No hand, no scrub. Playback, a tap on the ruler, a zoom and a reflow all move this
    // element, and none of them is a gesture.
    if (!scroller || !handRef.current || dragRef.current) return;

    // Announced as a drag, because to everything upstream that is exactly what it is: a
    // gesture in progress that owns the playhead. It is what stops the playback loop from
    // writing the playhead back over the scroll, sixty times a second, which is the same
    // tug of war that made the old playhead drag look frozen.
    if (!scrubbingRef.current) {
      scrubbingRef.current = true;
      onDragChange({ kind: 'playhead' });
    }

    const us = Math.max(0, Math.min(committedTotal, Math.round((scroller.scrollLeft / pxPerSecond) * 1_000_000)));
    /*
      One announcement per painted frame, no more.

      iOS emits scroll events faster than it paints, and every one of them used to become a
      React commit. Coalescing to an animation frame means the app is asked to re-render at
      most as often as the screen can show it — and because the scroller itself is native,
      the lane keeps moving under the finger even when a commit runs long. Reading
      `scrollLeft` again inside the frame is deliberate: the position when we paint is more
      current than the position when the event fired.
    */
    lastScrubRef.current = us;
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const live = scrollerRef.current;
        if (!live) return;
        const now = Math.max(
          0,
          Math.min(committedTotal, Math.round((live.scrollLeft / pxPerSecond) * 1_000_000)),
        );
        if (now !== announcedRef.current) {
          announcedRef.current = now;
          onSeek(now, false);
        }
      });
    }

    if (scrubTimerRef.current) clearTimeout(scrubTimerRef.current);
    scrubTimerRef.current = setTimeout(() => {
      scrubbingRef.current = false;
      handRef.current = false;
      lastScrubRef.current = null;
      // The exact seek, and the end of the gesture. Ordered so the player sees the final
      // position *and* the end of scrubbing in one commit, which is what turns the last
      // approximate seek into an exact one.
      announcedRef.current = null;
      onSeek(us, true);
      onDragChange(null);
    }, 140);
  }, [committedTotal, onDragChange, onSeek, pxPerSecond]);

  const applyDrag = useCallback(
    (clientX: number) => {
      const current = dragRef.current;
      if (!current) return;
      const delta = (toTime(clientX) - current.grabTime) * current.speed;
      const next: TrimDraft =
        current.edge === 'in'
          ? {
              clipId: current.clipId,
              edge: 'in',
              sourceIn: clamp(
                Math.round(current.originIn + delta),
                current.bounds.inMin,
                current.bounds.inMax,
              ),
              sourceOut: current.originOut,
              clamped: false,
            }
          : {
              clipId: current.clipId,
              edge: 'out',
              sourceIn: current.originIn,
              sourceOut: clamp(
                Math.round(current.originOut + delta),
                current.bounds.outMin,
                current.bounds.outMax,
              ),
              clamped: false,
            };

      // Say so when the drag is pushing against a limit, rather than silently pinning.
      const wanted = current.edge === 'in' ? current.originIn + delta : current.originOut + delta;
      const landed = current.edge === 'in' ? next.sourceIn : next.sourceOut;
      next.clamped = Math.abs(wanted - landed) > 1000;

      draftRef.current = next;
      setDraft(next);
      // The preview follows the dragged edge; the playhead is left alone. Writing it here
      // put a constant into the log on every frame and parked the playhead somewhere
      // playback would not resume from.
      onDragChange({
        kind: 'trim',
        scrubSourceTime: current.edge === 'in' ? next.sourceIn : Math.max(next.sourceIn, next.sourceOut - 40_000),
      });
    },
    [onDragChange, toTime],
  );

  const startDrag = useCallback(
    (event: React.PointerEvent, kind: DragKind) => {
      event.preventDefault();
      event.stopPropagation();
      (event.target as Element).setPointerCapture?.(event.pointerId);

      // A trim measures from where the finger actually landed, not from where the handle
      // is drawn. The hit area is 44px around a 12px grip, so pressing near its edge used
      // to charge the drag ~20px of offset before the finger had moved at all — around a
      // second of footage at a typical zoom, applied the instant the gesture started.
      const anchored: DragKind = { ...kind, grabTime: toTime(event.clientX) };

      dragRef.current = anchored;
      draftRef.current = null;
      setDrag(anchored);
      setDraft(null);
      // No `applyDrag` here. The finger is somewhere inside a 44px target around a 12px
      // handle, so acting on pointerdown would nudge the cut before the user moved.
      onDragChange({
        kind: 'trim',
        scrubSourceTime:
          anchored.edge === 'in' ? anchored.originIn : Math.max(anchored.originIn, anchored.originOut - 40_000),
      });
    },
    [onDragChange, toTime],
  );

  const moveDrag = useCallback(
    (event: React.PointerEvent) => {
      if (!dragRef.current) return;
      event.preventDefault();
      applyDrag(event.clientX);
    },
    [applyDrag],
  );

  const endDrag = useCallback(
    (event: React.PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      (event.target as Element).releasePointerCapture?.(event.pointerId);

      const pending = draftRef.current;
      dragRef.current = null;
      draftRef.current = null;
      setDrag(null);
      setDraft(null);
      onDragChange(null);

      if (!pending) return;
      // One op for the whole gesture, then park the playhead on the edge that was just
      // set — so releasing leaves you looking at the cut you made.
      onTrimCommit(current.clipId, pending.sourceIn, pending.sourceOut);
      const length = Math.round((pending.sourceOut - pending.sourceIn) / current.speed);
      onSeek(
        current.edge === 'in' ? current.originStart : Math.max(current.originStart, current.originStart + length - 40_000),
        true,
      );
    },
    [onDragChange, onSeek, onTrimCommit],
  );

  const zoom = (factor: number) => {
    const scroller = scrollerRef.current;
    const anchor = playhead;
    setPxPerSecond((previous) => {
      const next = clamp(previous * factor, MIN_PPS, maxPps);
      // Zoom around the playhead — it is where the user is looking — which with a fixed
      // playhead means holding `scrollLeft` on the same instant at the new scale.
      if (scroller) {
        requestAnimationFrame(() => {
          scroller.scrollLeft = Math.max(0, Math.round((anchor / 1_000_000) * next));
        });
      }
      return next;
    });
  };

  /*
    What the audio strip needs, reduced to plain data.

    Pulled out of the clips and the signals cache once rather than on every repaint, so the
    painter reads two small values instead of walking the whole timeline sixty times a
    second — and so a repaint can be forced by identity when either of them really changes.
  */
  const waveClips = useMemo(
    () =>
      clips.map((clip) => ({
        sourceId: clip.sourceId,
        start: clip.start,
        sourceIn: clip.sourceIn,
        sourceOut: clip.sourceOut,
        speed: clip.speed,
        enabled: clip.enabled,
      })),
    [clips],
  );
  const waveAudio = useMemo(() => {
    const out = new Map<string, WaveSource>();
    for (const [sourceId, measured] of signals) {
      if (measured.audio) {
        out.set(sourceId, {
          hopUs: measured.audio.hopUs,
          loudness: measured.audio.loudness,
          peakDb: measured.audio.peakDb,
          medianDb: measured.audio.medianDb,
        });
      }
    }
    return out;
  }, [signals]);

  /** Stable, so the memoised ruler is not re-rendered by a fresh closure every scroll. */
  const seekRef = useRef(onSeek);
  seekRef.current = onSeek;
  const scrollToTimeRef = useRef(scrollToTime);
  scrollToTimeRef.current = scrollToTime;
  const onRulerTap = useCallback((us: number) => {
    seekRef.current(us, true);
    scrollToTimeRef.current(us, true);
  }, []);

  /**
   * The strips' colours, read once.
   *
   * `getComputedStyle` is a style recalculation. Two of them inside a painter that runs on
   * every frame of every scroll is a forced synchronous layout sixty times a second, for
   * four values that never change.
   */
  const palette = useMemo(() => {
    const read = (name: string, fallback: string) => {
      if (typeof window === 'undefined') return fallback;
      const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return value || fallback;
    };
    return {
      strong: read('--tick-strong', '#8b8ba6'),
      faint: read('--tick', '#55556a'),
      bed: read('--wave-bed', '#241f3d'),
      ink: read('--wave-ink', '#a794ff'),
    };
  }, []);

  /** The level envelope's own resolution, so nothing is drawn finer than the data. */
  const hopUs = useMemo(() => {
    for (const source of waveAudio.values()) return source.hopUs;
    return 10_000;
  }, [waveAudio]);

  /**
   * The ruler, painted across the viewport.
   *
   * Same plan as before — `planRuler` decides the ladder, the labels and the frame grid —
   * drawn straight onto a canvas instead of into a few hundred absolutely positioned spans.
   */
  const paintRuler = useCallback(
    (ctx: CanvasRenderingContext2D, { scrollLeft, cssWidth }: StripView) => {
      const timeAt = (px: number) => ((px - halfWidth) / pxPerSecond) * 1_000_000;
      const plan = planRuler({
        fromUs: timeAt(scrollLeft),
        toUs: timeAt(scrollLeft + cssWidth),
        totalUs: committedTotal,
        pxPerSecond,
        frameRate: timeline.frameRate,
      });

      const { strong, faint } = palette;
      ctx.font = '10px -apple-system, system-ui, sans-serif';
      ctx.textBaseline = 'top';

      for (const tick of plan.ticks) {
        const x = Math.round((tick.us / 1_000_000) * pxPerSecond + halfWidth - scrollLeft);
        if (x < -40 || x > cssWidth + 40) continue;
        if (tick.label === null) {
          // One frame: short and a step down in weight, so the marks read as a scale to
          // count along without competing with the numbers.
          ctx.fillStyle = faint;
          ctx.fillRect(x, 21, 1, RULER_HEIGHT_PX - 21);
        } else {
          ctx.fillStyle = strong;
          ctx.fillRect(x, 12, 2, RULER_HEIGHT_PX - 12);
          ctx.fillText(tick.label, x + 5, 12);
        }
      }
    },
    [committedTotal, halfWidth, palette, pxPerSecond, timeline.frameRate],
  );

  /**
   * The audio, painted across the viewport.
   *
   * A column per device pixel, mirrored about the centre line — the shape reads as one
   * object rather than as a bar chart, and the centre gives the eye something to follow
   * through the quiet parts. Built as a single path and filled once.
   */
  const paintWave = useCallback(
    (ctx: CanvasRenderingContext2D, { scrollLeft, cssWidth, dpr }: StripView) => {
      const { bed, ink } = palette;

      // The bed covers the edit and nothing else: the lane carries half a viewport of
      // padding at each end so the first and last frame can reach the middle of the screen,
      // and audio drawn across that padding reads as sound before the video starts.
      const bedFrom = Math.max(0, halfWidth - scrollLeft);
      const bedTo = Math.min(cssWidth, halfWidth + (committedTotal / 1_000_000) * pxPerSecond - scrollLeft);
      if (bedTo > bedFrom) {
        ctx.fillStyle = bed;
        ctx.fillRect(bedFrom, 0, bedTo - bedFrom, WAVE_HEIGHT_PX);
      }
      if (waveAudio.size === 0) return;

      /*
        Never sample finer than the data. At full zoom one hop of the level envelope is a
        dozen pixels wide, so drawing a column per device pixel computed the same answer
        twelve times over; at fit a hop is a fraction of a pixel and the column is what
        limits it. Taking whichever is coarser is a tenfold saving where it is needed and
        identical output everywhere.
      */
      const hopPx = (hopUs / 1_000_000) * pxPerSecond;
      const step = Math.max(1 / dpr, Math.min(hopPx / 2, 4));
      const columns = Math.ceil(cssWidth / step);
      const levels = waveColumns({
        clips: waveClips,
        audio: waveAudio,
        fromUs: ((scrollLeft - halfWidth) / pxPerSecond) * 1_000_000,
        usPerColumn: (step / pxPerSecond) * 1_000_000,
        columns,
      });

      /*
        One outline, not a rectangle per column.

        A column-per-rectangle path is the obvious way to draw this and it was, by a wide
        margin, the most expensive thing in the editor during a fast scrub: eight hundred
        separate rectangles on fractional pixel boundaries, each anti-aliased on both edges,
        rasterised every frame. Measured at four times the frame budget under throttling —
        remove it and a flick's worst frame went from 383ms to 112ms.

        Tracing the envelope instead — along the top left to right, back along the bottom —
        is one polygon with the same number of points and a fraction of the rasterisation,
        and it looks better: a continuous shape rather than a picket fence. Runs of silence
        break it into separate sub-paths so a gap stays a gap.
      */
      const middle = WAVE_HEIGHT_PX / 2;
      const path = new Path2D();
      let run = -1;
      const closeRun = (until: number) => {
        if (run < 0) return;
        for (let column = until - 1; column >= run; column -= 1) {
          const half = Math.max(step / 2, levels[column]! * middle);
          path.lineTo((column + 1) * step, middle + half);
        }
        path.closePath();
        run = -1;
      };
      for (let column = 0; column < columns; column += 1) {
        const level = levels[column]!;
        if (level <= 0) {
          closeRun(column);
          continue;
        }
        const half = Math.max(step / 2, level * middle);
        if (run < 0) {
          run = column;
          path.moveTo(column * step, middle - half);
        }
        path.lineTo(column * step, middle - half);
        path.lineTo((column + 1) * step, middle - half);
      }
      closeRun(columns);
      ctx.fillStyle = ink;
      ctx.fill(path);
    },
    [committedTotal, halfWidth, hopUs, palette, pxPerSecond, waveAudio, waveClips],
  );

  // A new identity forces a repaint where the position alone would not: a zoom, an edit, a
  // source finishing its measurement.
  const rulerToken = useMemo(
    () => ({}),
    [committedTotal, halfWidth, pxPerSecond, timeline.frameRate],
  );
  const waveToken = useMemo(
    () => ({}),
    [committedTotal, halfWidth, pxPerSecond, waveAudio, waveClips],
  );
  const rulerRef = useStripCanvas(scrollerRef, RULER_HEIGHT_PX, paintRuler, rulerToken);
  const waveRef = useStripCanvas(scrollerRef, WAVE_HEIGHT_PX, paintWave, waveToken);

  const selected = clips.find((c) => c.id === selectedClipId) ?? null;
  const selectedSource = selected ? sources.find((s) => s.id === selected.sourceId) ?? null : null;

  /**
   * The lane, built once per thing that can change it — and a playhead is not one of them.
   *
   * `ClipBlock` has been memoised for a while, which stops each block *re-rendering* on a
   * scroll. It does not stop the twenty-four elements being created, their props being
   * compared, and the geometry being recomputed three times per clip, sixty times a second,
   * because this component still re-renders at the frame rate: it owns the clock, the
   * playhead's `aria-valuenow`, and the ruler's window.
   *
   * Measured on the fixture under 6x throttling, that residue was 23ms a frame for
   * twenty-three extra clips — a memoised lane costing per-clip work anyway. Held in a memo
   * of its own, React reuses the element tree outright and a scroll stops reaching the lane
   * at all.
   */
  const lane = useMemo(
    () => (
      <div className="timeline-lane" onPointerDown={() => onSelect(null)}>
        {clips.map((clip, index) => {
          const box = geometryOf(clip);
          return (
            <ClipBlock
              key={clip.id}
              clip={clip}
              index={index}
              strip={strips.get(clip.sourceId)}
              left={box.left}
              width={box.width}
              keys={draftKeys?.clipId === clip.id ? draftKeys.keys : keyframesOn(clip)}
              draft={draft?.clipId === clip.id ? draft : null}
              selected={clip.id === selectedClipId}
              onSelect={onSelect}
            />
          );
        })}

        {/*
          Not gated on the coarse pass being committed, for the same reason Cut, Drop and
          Delete are not: `coarseSnapshot` already holds a copy of exactly what the coarse
          pass was, so there is nothing for a gate to protect — and the detailed edit, where
          a shot gets trimmed two frames off its head, is the work that happens *after*
          Done. Freezing the handles took away the one gesture the second half of the job is
          made of.
        */}
        {selected && selectedSource && (
          <TrimHandles
            clip={selected}
            source={selectedSource}
            geometry={geometryOf(selected)}
            draft={draft?.clipId === selected.id ? draft : null}
            pxPerSecond={pxPerSecond}
            onStart={startDrag}
          />
        )}
      </div>
    ),
    [
      clips,
      draft,
      draftKeys,
      geometryOf,
      onSelect,
      pxPerSecond,
      selected,
      selectedClipId,
      selectedSource,
      startDrag,
      strips,
    ],
  );

  // Sorted and clustered, which is not free on a long pass and does not depend on the
  // playhead — so it must not be redone sixty times a second while the lane is moving.
  const bubbles = useMemo(
    () => clusterBubbles(previews, accepted, pxPerSecond),
    [previews, accepted, pxPerSecond],
  );

  return (
    <section className="timeline" aria-label="Timeline">
      <div className="timeline-tools">
        <span className="timeline-clock">{formatTimecode(playhead, undefined, { compact: true })}</span>
        <span className="timeline-spacer" />
        <button className="icon" onClick={() => zoom(1 / 1.6)} aria-label="Zoom out" disabled={pxPerSecond <= MIN_PPS}>
          −
        </button>
        <button className="icon" onClick={fit} aria-label="Fit timeline">
          Fit
        </button>
        <button className="icon" onClick={() => zoom(1.6)} aria-label="Zoom in" disabled={pxPerSecond >= maxPps}>
          ＋
        </button>
      </div>

      {/*
        A wrapper so the playhead can be pinned to the middle of the *scroller* without
        scrolling with its contents. It has to be a sibling of the scrolled element rather
        than a child, or it moves with the footage — which is the one thing it must not do.
      */}
      <div className="timeline-viewport">
      {/*
        Outside the scroller, both of them. They are painted from `scrollLeft` rather than
        moved by it — see `useStripCanvas` for what that bought.
      */}
      <canvas
        className="ruler"
        ref={rulerRef}
        onClick={(event) => {
          const scroller = scrollerRef.current;
          const box = (scroller ?? event.currentTarget).getBoundingClientRect();
          const at = event.clientX - box.left + (scroller?.scrollLeft ?? 0) - halfWidth;
          onRulerTap(Math.max(0, Math.round((at / pxPerSecond) * 1_000_000)));
        }}
      />
      <div
        className={drag ? 'timeline-scroller dragging' : 'timeline-scroller'}
        ref={scrollerRef}
        onScroll={onScroll}
        // The positive signal. `onPointerDownCapture` so a press that lands on a clip —
        // which stops propagation to select it — still counts as a hand on the lane.
        onPointerDownCapture={noteHand}
        onTouchStartCapture={noteHand}
        onWheel={noteHand}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="timeline-content" style={{ width: contentWidth }}>
          {bubbles.length > 0 && (
            <div className="bubbles">
              {bubbles.map((bubble) => (
                <button
                  key={bubble.key}
                  className={bubbleClass(bubble)}
                  style={{ left: toX(bubble.atUs) }}
                  onClick={() => onOpenSuggestion(bubble.indices[0]!)}
                  aria-label={
                    bubble.indices.length > 1
                      ? `${bubble.indices.length} suggestions here`
                      : bubble.headline
                  }
                >
                  <span aria-hidden="true">{bubble.indices.length > 1 ? bubble.indices.length : bubble.glyph}</span>
                </button>
              ))}
            </div>
          )}

          {lane}

        </div>
      </div>

      <canvas className="wave-lane" ref={waveRef} aria-hidden="true" />

      {/*
        Pinned to the middle of the viewport. The playhead is no longer a thing on the
        timeline that can be at the wrong place — it is a mark on the screen, and the
        timeline moves behind it.
      */}
      <div
        className="playhead"
        role="slider"
        aria-label="Playhead"
        aria-valuemin={0}
        aria-valuemax={committedTotal}
        aria-valuenow={playhead}
        aria-orientation="horizontal"
        tabIndex={0}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 1_000_000 : 100_000;
          if (event.key === 'ArrowLeft') onSeek(Math.max(0, playhead - step), true);
          else if (event.key === 'ArrowRight') onSeek(Math.min(committedTotal, playhead + step), true);
          else return;
          event.preventDefault();
        }}
      >
        <div className="playhead-line" />
      </div>
      </div>
    </section>
  );
}

/** Height of the ruler band, which the stylesheet also knows. */
const RULER_HEIGHT_PX = 30;
/** Height of the audio band, which the stylesheet knows as `--wave-height`. */
const WAVE_HEIGHT_PX = 34;

/**
 * The two strips that do not scroll.
 *
 * ## Why they stopped scrolling
 *
 * The ruler and the audio used to live *inside* the scrolled content, positioned in
 * timeline pixels, windowed to a few pages either side of the playhead so the DOM stayed
 * bounded. That is a reasonable design and it was measured to be the single largest cost in
 * the editor. Playing a twelve-clip edit at full zoom under six-times throttling:
 *
 *     everything             median 37ms/frame, 20 hitches in five seconds
 *     without the ruler      median 33ms,       16 hitches
 *     without either strip   median 25ms,       10 hitches
 *
 * Two thirds of a frame budget, and half the visible stutter, spent painting decoration
 * across a canvas over a million pixels wide — plus a burst of a hundred DOM operations
 * every time the window slid a page, which is a hitch you can see and is exactly what
 * "jumpy while playing zoomed in" describes. Auto-scrolling the lane, which was the obvious
 * suspect, measured at zero.
 *
 * ## What they are instead
 *
 * One canvas each, the size of the *viewport*, sitting outside the scroller and repainted
 * from `scrollLeft` whenever the view moves. A repaint is a few hundred drawing operations
 * over four hundred pixels rather than a repaint of a strip a million pixels long, there is
 * no DOM to build or throw away, and there is no window to slide — so the periodic hitch
 * has nowhere to come from.
 *
 * What is drawn is decided by the same two pure functions as before, `planRuler` and
 * `waveColumns`, which are tested exactly. Only the surface changed.
 */
interface StripView {
  scrollLeft: number;
  cssWidth: number;
  /** Device pixels per CSS pixel, so nothing is drawn finer than the screen can show. */
  dpr: number;
}

/**
 * How much canvas is painted beyond each edge of the viewport.
 *
 * The strips only ever *translate* as the view moves — the ruler at 0:04 is the same picture
 * as the ruler at 0:03, shifted. Repainting the whole thing every frame therefore uploads a
 * new texture sixty times a second to draw something that has barely changed, which measured
 * as the largest remaining cost in the editor.
 *
 * So each canvas is painted wider than it needs to be and slid with a transform, which is
 * compositor work and free. It is only repainted when the view has run past the margin —
 * at playback speed, once every few frames instead of every one.
 */
const STRIP_MARGIN_PX = 240;

/**
 * Paint a canvas whenever the view moves past what has already been painted.
 *
 * Driven by an animation frame reading `scrollLeft` rather than by scroll events, because
 * the view also moves during *playback*, where there is no gesture and the scroll is issued
 * by the app. One number compared per frame is cheaper than either of the alternatives, and
 * it cannot miss a movement.
 *
 * `token` is whatever the drawing depends on besides position — zoom, clips, audio. A new
 * identity forces a repaint where the position alone would not.
 */
function useStripCanvas(
  scrollerRef: React.RefObject<HTMLDivElement | null>,
  heightPx: number,
  paint: (ctx: CanvasRenderingContext2D, view: StripView) => void,
  token: object,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const paintRef = useRef(paint);
  paintRef.current = paint;

  useEffect(() => {
    const drawn = { at: Number.NaN, width: -1, shift: Number.NaN, seen: Number.NaN, margin: -1 };
    let frame = requestAnimationFrame(function tick() {
      frame = requestAnimationFrame(tick);
      const canvas = canvasRef.current;
      const scroller = scrollerRef.current;
      if (!canvas || !scroller) return;

      const cssWidth = scroller.clientWidth;
      const scrollLeft = scroller.scrollLeft;
      const shift = drawn.at - scrollLeft;

      /*
        How far the view moved since the last frame decides how much is worth painting.

        Slow — playback, or a thumb dragging — moves a few dozen pixels a frame, so painting
        a margin either side means most frames are a transform and nothing else. A flick
        moves five hundred pixels a frame, runs off the margin every time, and repaints
        regardless: there the margin is pure waste, two and a half viewports of texture
        uploaded per frame to show one. So it is dropped while the view is travelling and
        taken back the moment it slows, which is also the moment anyone can read it.
      */
      const velocity = Math.abs(scrollLeft - (Number.isNaN(drawn.seen) ? scrollLeft : drawn.seen));
      drawn.seen = scrollLeft;
      const travelling = velocity > STRIP_MARGIN_PX;
      const margin = travelling ? 0 : STRIP_MARGIN_PX;

      if (cssWidth === drawn.width && margin === drawn.margin && Math.abs(shift) <= margin) {
        // Still inside what has been painted: slide it and do no drawing at all. Written
        // only when it changed — assigning the same style string still costs a style
        // invalidation, and this runs on every frame of every gesture.
        if (shift !== drawn.shift) {
          drawn.shift = shift;
          canvas.style.transform = `translateX(${shift}px)`;
        }
        return;
      }

      drawn.at = scrollLeft;
      drawn.width = cssWidth;
      drawn.shift = 0;
      drawn.margin = margin;
      canvas.style.transform = 'translateX(0px)';
      canvas.style.left = `${-margin}px`;

      /*
        And at screen resolution only when the picture is still enough to be read.

        A flick repaints on every frame — it outruns any margin — and at two device pixels
        per CSS pixel across two and a half viewports that is the largest texture upload in
        the app, measured at four times the frame budget under throttling. Nobody reads a
        frame number off a ruler travelling at five hundred pixels a frame; the moment it
        slows, the next repaint is at full resolution.
      */
      const dpr = travelling ? 1 : Math.min(2, window.devicePixelRatio || 1);
      const paintedWidth = cssWidth + margin * 2;
      const width = Math.max(1, Math.round(paintedWidth * dpr));
      const height = Math.max(1, Math.round(heightPx * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        canvas.style.width = `${paintedWidth}px`;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, paintedWidth, heightPx);
      // The painter is handed the wider view and knows nothing about the margin; the canvas
      // is offset by it in the stylesheet.
      paintRef.current(ctx, { scrollLeft: scrollLeft - margin, cssWidth: paintedWidth, dpr });
    });
    return () => cancelAnimationFrame(frame);
  }, [heightPx, scrollerRef, token]);

  return canvasRef;
}

/**
 * One clip on the lane.
 *
 * Memoised, and that is the whole reason its props look the way they do. `left` and `width`
 * arrive as numbers rather than inside a geometry object, and `onSelect` is one shared
 * callback taking a clip id rather than a closure built per block — a freshly-built object
 * or function in the props defeats `memo` completely, and a `memo` that never bails is
 * slower than no `memo` at all.
 *
 * With this in place a playhead change re-renders the timeline shell and none of its
 * fifty-one children, which is the difference between a scroll that tracks a finger and
 * one that locks the phone.
 */
const ClipBlock = memo(function ClipBlock({
  clip,
  index,
  strip,
  left,
  width,
  keys,
  draft,
  selected,
  onSelect,
}: {
  clip: Clip;
  index: number;
  strip: Filmstrip | undefined;
  left: number;
  width: number;
  /** Framing keyframes, in clip-output microseconds. */
  keys: ReadonlyArray<{ t: number }>;
  draft: TrimDraft | null;
  selected: boolean;
  onSelect(clipId: string): void;
}) {
  const geometry = { left, width };
  /** Where a press landed, so a release can tell a tap from the start of a pan. */
  const pressRef = useRef<{ x: number; y: number } | null>(null);
  const sourceIn = draft ? draft.sourceIn : clip.sourceIn;
  const sourceOut = draft ? draft.sourceOut : clip.sourceOut;
  const length = Math.round((sourceOut - sourceIn) / clip.speed);
  const classes = ['clip-block', selected ? 'selected' : '', clip.enabled ? '' : 'dropped', draft ? 'trimming' : '']
    .filter(Boolean)
    .join(' ');

  // Sampled across the range the clip currently uses, so the strip re-aims as the edge
  // moves instead of stretching — and bounded, by the block's width *and* by how many
  // frames the filmstrip actually holds for this stretch. See `thumbnailSlots`.
  const slots = thumbnailSlots(
    geometry.width,
    sourceOut - sourceIn,
    strip ? frameSpacingUs(strip) : Number.POSITIVE_INFINITY,
  );
  const thumbs = Array.from({ length: slots }, (_, i) =>
    strip ? frameAt(strip, sourceIn + ((i + 0.5) / slots) * (sourceOut - sourceIn)) : null,
  );

  return (
    <div
      className={classes}
      style={{ left: geometry.left, width: geometry.width }}
      /*
        Selected on release, not on press.

        Selecting on `pointerdown` re-renders the lane — the block gains its outline, the
        trim handles mount — in the middle of the gesture that press began, and Chromium
        drops the scroll it had just started. The effect is that the *first* drag on any clip
        that is not already selected does nothing at all, and since most of the timeline's
        surface is clips, most first drags do nothing. It reads as the timeline ignoring you.

        Waiting for the release costs nothing — a tap still selects — and a press that turns
        into a pan is a pan.
      */
      onPointerDown={(event) => {
        event.stopPropagation();
        pressRef.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerUp={(event) => {
        const press = pressRef.current;
        pressRef.current = null;
        if (!press) return;
        const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y);
        if (moved <= TAP_SLOP_PX) onSelect(clip.id);
      }}
      onPointerCancel={() => {
        pressRef.current = null;
      }}
      role="button"
      aria-pressed={selected}
      aria-label={`Clip ${index + 1}, ${formatTimecode(sourceOut - sourceIn, undefined, { compact: true })}`}
    >
      <div className="clip-thumbs">
        {thumbs.map((frame, i) => {
          /*
            Each frame covers its own share of the block, *tiled* rather than stretched.

            Stretching is what a flex row did, and it falls apart once the zoom outruns the
            filmstrip: a thirty-second clip at full zoom is thirty-five thousand pixels wide
            and the strip holds two frames for it, so each 144-pixel JPEG was rasterised to
            seventeen thousand pixels across and re-rasterised as it scrolled. Drawing them
            at a fixed width instead left the lane mostly empty, which is worse to look at
            and no more true.

            A repeating background is one element either way, tiled by the compositor from a
            texture the size the picture actually is.
          */
          const share = geometry.width / slots;
          const style = { left: i * share, width: share };
          return frame ? (
            <span
              key={i}
              className="thumb"
              style={{ ...style, backgroundImage: `url(${frame.url})` }}
            />
          ) : (
            <span key={i} className="thumb-placeholder" style={style} />
          );
        })}
      </div>
      {/*
        Keyframes, on the clip they belong to.

        Drawn along the bottom edge rather than in the middle, so they read as marks on the
        shot rather than as things to grab — they are not draggable here, and a diamond
        sitting over the thumbnails invites a drag that does nothing.
      */}
      {keys.length > 0 && (
        <div className="clip-keys" aria-hidden="true">
          {keys.map((key) => (
            <span
              key={key.t}
              className="clip-key"
              style={{ left: `${Math.max(0, Math.min(100, (key.t / Math.max(1, length)) * 100))}%` }}
            />
          ))}
        </div>
      )}
      <span className="clip-badge">
        {index + 1}
        {clip.speed !== 1 && <em> {clip.speed}×</em>}
        {clip.effects.length > 0 && <em> fx</em>}
        {!clip.enabled && <em> off</em>}
      </span>
      {draft && (
        <span className="clip-length">
          {formatTimecode(Math.round((sourceOut - sourceIn) / clip.speed), undefined, { compact: true })}
        </span>
      )}
    </div>
  );
});

/** A clip's committed framing keyframes, or none. */
function keyframesOn(clip: Clip): ReadonlyArray<{ t: number }> {
  for (const effect of clip.effects) {
    if (effect.type === 'transform' && effect.enabled) return effect.keyframes;
  }
  return EMPTY_KEYS;
}

/** One shared empty array, so an ungraded clip's `keys` prop is referentially stable and
    `memo` keeps bailing out on it. */
const EMPTY_KEYS: ReadonlyArray<{ t: number }> = [];

/**
 * The trim handles, plus the ghost of the footage waiting on either side.
 *
 * The ghost is not decoration. "Drag the end to extend" is invisible otherwise — there is
 * nothing on screen to suggest the clip could get longer, or by how much. Drawing the
 * available raw footage as a dimmed band makes the affordance and its limit one shape.
 */
function TrimHandles({
  clip,
  source,
  geometry,
  draft,
  pxPerSecond,
  onStart,
}: {
  clip: Clip;
  source: Source;
  geometry: { left: number; width: number };
  draft: TrimDraft | null;
  pxPerSecond: number;
  onStart(event: React.PointerEvent, kind: DragKind): void;
}) {
  const bounds = trimBounds(clip, source.duration);
  const px = (us: number) => (us / 1_000_000 / clip.speed) * pxPerSecond;
  const inX = geometry.left;
  const outX = geometry.left + geometry.width;

  const grab = (edge: 'in' | 'out'): DragKind => ({
    type: 'trim',
    clipId: clip.id,
    edge,
    grabTime: edge === 'in' ? clip.start : clipEnd(clip),
    originIn: clip.sourceIn,
    originOut: clip.sourceOut,
    originStart: clip.start,
    speed: clip.speed,
    bounds,
  });

  return (
    <>
      {bounds.headroom.head > 0 && (
        <div className="headroom" style={{ left: inX - px(bounds.headroom.head), width: px(bounds.headroom.head) }} />
      )}
      {bounds.headroom.tail > 0 && <div className="headroom" style={{ left: outX, width: px(bounds.headroom.tail) }} />}

      {(['in', 'out'] as const).map((edge) => {
        const active = draft?.edge === edge;
        const classes = ['trim-handle', edge, active ? 'active' : '', active && draft.clamped ? 'clamped' : '']
          .filter(Boolean)
          .join(' ');
        return (
          <div
            key={edge}
            className={classes}
            style={{ left: edge === 'in' ? inX : outX }}
            onPointerDown={(event) => onStart(event, grab(edge))}
            role="slider"
            aria-label={edge === 'in' ? 'Clip start' : 'Clip end'}
            aria-valuemin={edge === 'in' ? bounds.inMin : bounds.outMin}
            aria-valuemax={edge === 'in' ? bounds.inMax : bounds.outMax}
            aria-valuenow={edge === 'in' ? clip.sourceIn : clip.sourceOut}
            tabIndex={0}
          >
            <span className="grip" />
          </div>
        );
      })}
    </>
  );
}

/**
 * Suggestion bubbles, merged where they would overlap.
 *
 * A refinement pass over a nine-minute assembly can return forty suggestions, and at a
 * zoom where the whole edit fits on a phone screen most of them land within a few pixels
 * of each other. Drawing them all produces a smear that can neither be read nor tapped, so
 * anything within a thumb's width becomes one bubble carrying a count. The full list is
 * always a tap away, which is what that count is for.
 */
interface Bubble {
  key: string;
  atUs: number;
  indices: number[];
  glyph: string;
  headline: string;
  accepted: boolean;
  stale: boolean;
}

export function clusterBubbles(previews: OpPreview[], accepted: boolean[], pxPerSecond: number): Bubble[] {
  const gapUs = (BUBBLE_CLUSTER_PX / Math.max(1, pxPerSecond)) * 1_000_000;
  const sorted = [...previews].sort((a, b) => a.anchorUs - b.anchorUs);
  const out: Bubble[] = [];

  for (const preview of sorted) {
    const last = out.at(-1);
    if (last && preview.anchorUs - last.atUs <= gapUs) {
      last.indices.push(preview.index);
      // A cluster counts as accepted only when all of it is — a half-ticked group that
      // looked settled would be the one thing worse than no indicator at all.
      last.accepted = last.accepted && (accepted[preview.index] ?? false);
      last.stale = last.stale || !preview.applicable;
      continue;
    }
    out.push({
      key: `bubble-${preview.index}`,
      atUs: preview.anchorUs,
      indices: [preview.index],
      glyph: glyphFor(preview),
      headline: preview.headline,
      accepted: accepted[preview.index] ?? false,
      stale: !preview.applicable,
    });
  }

  return out;
}

function glyphFor(preview: OpPreview): string {
  switch (preview.op.op) {
    case 'trim':
      return '✂';
    case 'setSpeed':
      return '»';
    case 'remove':
    case 'setEnabled':
      return '⊘';
    case 'addEffect':
      return '⊙';
    case 'split':
      return '⌇';
    default:
      return '•';
  }
}

function bubbleClass(bubble: Bubble): string {
  return ['bubble', bubble.accepted ? 'accepted' : '', bubble.stale ? 'stale' : ''].filter(Boolean).join(' ');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
