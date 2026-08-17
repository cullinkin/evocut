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
import { frameAt, useFilmstrips, type Filmstrip } from './filmstrip.ts';
import { usePlayhead } from './playhead.ts';
import { planRuler } from './ruler.ts';

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
  frozen: boolean;
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
/**
 * How much ruler is built at once, in pixels.
 *
 * The ruler used to span the whole edit, which was fine at half-second steps and ruinous at
 * frame steps: a 73-second assembly at full zoom is 85,000 pixels wide and two thousand
 * marks, rebuilt on every scroll event because the ruler re-renders with the timeline. So it
 * is built a page at a time, three pages wide, and the page only changes when the playhead
 * crosses a boundary — which during a scrub is a few times a second rather than sixty.
 */
const RULER_PAGE_PX = 1600;
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
  frozen,
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
      if (frozen) return;
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
    [frozen, onDragChange, toTime],
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
    Which page of the ruler is on screen.

    Deliberately coarse. The window has to follow the scroll, but recomputing it from the
    playhead every frame would rebuild every tick sixty times a second, which is the cost
    the ruler was windowed to avoid in the first place. A page is wider than the viewport,
    three of them are drawn, and the number only changes when a boundary goes past.
  */
  const rulerPage = Math.floor(((playhead / 1_000_000) * pxPerSecond) / RULER_PAGE_PX);

  /** Stable, so the memoised ruler is not re-rendered by a fresh closure every scroll. */
  const seekRef = useRef(onSeek);
  seekRef.current = onSeek;
  const scrollToTimeRef = useRef(scrollToTime);
  scrollToTimeRef.current = scrollToTime;
  const onRulerTap = useCallback((us: number) => {
    seekRef.current(us, true);
    scrollToTimeRef.current(us, true);
  }, []);

  const selected = clips.find((c) => c.id === selectedClipId) ?? null;
  const selectedSource = selected ? sources.find((s) => s.id === selected.sourceId) ?? null : null;
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
          <Ruler
            total={committedTotal}
            pxPerSecond={pxPerSecond}
            offset={halfWidth}
            page={rulerPage}
            frameRateNum={timeline.frameRate.num}
            frameRateDen={timeline.frameRate.den}
            onTap={onRulerTap}
          />

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

            {selected && selectedSource && !frozen && (
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

        </div>
      </div>

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

/**
 * The ruler.
 *
 * Memoised on primitives — the frame rate arrives as two numbers rather than a `Rational`
 * because a fresh object in the props defeats `memo` entirely — and windowed to `page`, so
 * a scroll rebuilds its marks a few times a second instead of sixty. What it draws at each
 * zoom, and why the ladder is shaped the way it is, is in `ruler.ts`.
 */
const Ruler = memo(function Ruler({
  total,
  pxPerSecond,
  offset,
  page,
  frameRateNum,
  frameRateDen,
  onTap,
}: {
  total: number;
  pxPerSecond: number;
  offset: number;
  page: number;
  frameRateNum: number;
  frameRateDen: number;
  onTap(us: number): void;
}) {
  const plan = useMemo(() => {
    const toUs = (px: number) => (px / pxPerSecond) * 1_000_000;
    return planRuler({
      // A page of slack on each side, so the marks are already there when the edge of the
      // screen reaches them rather than appearing as you arrive.
      fromUs: toUs((page - 1) * RULER_PAGE_PX),
      toUs: toUs((page + 2) * RULER_PAGE_PX),
      totalUs: total,
      pxPerSecond,
      frameRate: { num: frameRateNum, den: frameRateDen },
    });
  }, [frameRateDen, frameRateNum, page, pxPerSecond, total]);

  return (
    // Dragging the ruler pans the lane like everything else; a *tap* brings that instant
    // to the middle. Both gestures land the playhead somewhere you pointed at, which is
    // the only thing the old drag-the-grip version was really for.
    <div
      className="ruler"
      onClick={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        onTap(Math.max(0, Math.round(((event.clientX - box.left - offset) / pxPerSecond) * 1_000_000)));
      }}
    >
      {plan.ticks.map((tick) => (
        <span
          key={tick.frame}
          className={tick.label === null ? 'tick minor' : 'tick'}
          style={{ left: (tick.us / 1_000_000) * pxPerSecond + offset }}
        >
          {tick.label}
        </span>
      ))}
    </div>
  );
});

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
  const sourceIn = draft ? draft.sourceIn : clip.sourceIn;
  const sourceOut = draft ? draft.sourceOut : clip.sourceOut;
  const length = Math.round((sourceOut - sourceIn) / clip.speed);
  const classes = ['clip-block', selected ? 'selected' : '', clip.enabled ? '' : 'dropped', draft ? 'trimming' : '']
    .filter(Boolean)
    .join(' ');

  // One thumbnail per ~56px of block, sampled across the range the clip currently uses,
  // so the strip re-aims as the edge moves instead of stretching.
  const slots = Math.max(1, Math.round(geometry.width / 56));
  const thumbs = Array.from({ length: slots }, (_, i) =>
    strip ? frameAt(strip, sourceIn + ((i + 0.5) / slots) * (sourceOut - sourceIn)) : null,
  );

  return (
    <div
      className={classes}
      style={{ left: geometry.left, width: geometry.width }}
      onPointerDown={(event) => {
        event.stopPropagation();
        onSelect(clip.id);
      }}
      role="button"
      aria-pressed={selected}
      aria-label={`Clip ${index + 1}, ${formatTimecode(sourceOut - sourceIn, undefined, { compact: true })}`}
    >
      <div className="clip-thumbs">
        {thumbs.map((frame, i) =>
          frame ? (
            <img key={i} src={frame.url} alt="" draggable={false} />
          ) : (
            <span key={i} className="thumb-placeholder" />
          ),
        )}
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
