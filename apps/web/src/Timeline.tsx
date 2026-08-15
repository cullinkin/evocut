import { useCallback, useEffect, useRef, useState } from 'react';
import {
  clipEnd,
  formatTimecode,
  outputDuration,
  timelineDuration,
  trimBounds,
  type Clip,
  type Source,
  type Timeline as TimelineDoc,
} from '@evocut/edl';
import { frameAt, useFilmstrip } from './filmstrip.ts';

/**
 * The editing timeline: draggable playhead, tap-to-select clips, drag-the-edges trimming.
 *
 * ## Touch, specifically
 *
 * Everything here is built on Pointer Events with `setPointerCapture`, not touch events:
 * capture means a drag keeps receiving moves even when the finger leaves the element it
 * started on, which is most drags on a phone screen this size.
 *
 * The lane scrolls natively (`touch-action: pan-x`) while the playhead and trim handles
 * set `touch-action: none`. That combination is what stops iOS from stealing a trim
 * gesture and turning it into a scroll — the property is per-element, so the two
 * behaviours can coexist without a global gesture manager.
 *
 * Handles are 44px of touch target around a 3px line. A thumb is about 9mm across, and
 * the visual affordance for a trim handle cannot be, so the hit area and the paint are
 * deliberately different sizes.
 *
 * ## Live drags, single ops
 *
 * A trim drag fires sixty times a second; committing an op per move would bury the
 * revision chain and the log under gesture noise. The drag renders from a local draft and
 * emits exactly one `trim` op on release — so what lands in the EDL is the decision, not
 * the finger movement that produced it.
 */
export interface TimelineProps {
  timeline: TimelineDoc;
  sources: Source[];
  mediaUrls: Map<string, string>;
  playhead: number;
  selectedClipId: string | null;
  frozen: boolean;
  onSeek(us: number, final: boolean): void;
  onSelect(clipId: string | null): void;
  onTrimPreview(clipId: string, sourceIn: number, sourceOut: number): void;
  onTrimCommit(clipId: string, sourceIn: number, sourceOut: number): void;
  onTrimCancel(): void;
}

/** Horizontal padding inside the scroller, so the first and last frame can be reached. */
const EDGE_PAD = 24;
const MIN_PPS = 4;
const MAX_PPS = 400;
/** Within this many pixels of the edge, a drag scrolls the lane along with it. */
const AUTOSCROLL_MARGIN = 44;
const AUTOSCROLL_MAX_PPF = 14;

/**
 * A live drag.
 *
 * Trim drags carry the state they started from. They have to: the track is gapless, so a
 * clip's `start` is pinned by whatever precedes it and only its *length* changes. Deriving
 * the new edge from the clip's current position each frame would feed the drag back into
 * itself — the edge moves, the next frame measures against the moved edge, and the handle
 * accelerates away from the finger. Measuring against the position the drag began at is
 * stable and gives the finger a 1:1 relationship with source time.
 */
type DragKind =
  | { type: 'playhead' }
  | {
      type: 'trim';
      clipId: string;
      edge: 'in' | 'out';
      grabTime: number;
      originIn: number;
      originOut: number;
      speed: number;
      start: number;
    };

export function TimelineEditor({
  timeline,
  sources,
  mediaUrls,
  playhead,
  selectedClipId,
  frozen,
  onSeek,
  onSelect,
  onTrimPreview,
  onTrimCommit,
  onTrimCancel,
}: TimelineProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [pxPerSecond, setPxPerSecond] = useState(40);
  const [drag, setDrag] = useState<DragKind | null>(null);
  const pointerXRef = useRef(0);
  const dragRef = useRef<DragKind | null>(null);
  const lastTrimRef = useRef<{ sourceIn: number; sourceOut: number } | null>(null);

  const track = timeline.tracks[0];
  const clips = track?.clips ?? [];
  const total = timelineDuration(timeline);
  const contentWidth = (total / 1_000_000) * pxPerSecond + EDGE_PAD * 2;

  const toX = useCallback((us: number) => (us / 1_000_000) * pxPerSecond + EDGE_PAD, [pxPerSecond]);

  const toTime = useCallback(
    (clientX: number) => {
      const scroller = scrollerRef.current;
      if (!scroller) return 0;
      const rect = scroller.getBoundingClientRect();
      const x = clientX - rect.left + scroller.scrollLeft - EDGE_PAD;
      return Math.max(0, Math.round((x / pxPerSecond) * 1_000_000));
    },
    [pxPerSecond],
  );

  /** Fit the whole timeline on first sight, and whenever it would otherwise overflow badly. */
  const fit = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller || total <= 0) return;
    const usable = Math.max(120, scroller.clientWidth - EDGE_PAD * 2);
    setPxPerSecond(clamp((usable / (total / 1_000_000)), MIN_PPS, MAX_PPS));
  }, [total]);

  const fittedRef = useRef(false);
  useEffect(() => {
    if (fittedRef.current || total <= 0) return;
    fittedRef.current = true;
    fit();
  }, [fit, total]);

  // Keep the playhead on screen during playback and after a seek from elsewhere.
  useEffect(() => {
    if (drag) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;

    const x = toX(playhead);
    const left = scroller.scrollLeft;
    const right = left + scroller.clientWidth;
    if (x < left + AUTOSCROLL_MARGIN || x > right - AUTOSCROLL_MARGIN) {
      scroller.scrollTo({ left: Math.max(0, x - scroller.clientWidth / 2), behavior: 'smooth' });
    }
  }, [playhead, toX, drag]);

  /**
   * While a drag is live, scroll the lane when the finger nears an edge.
   *
   * Runs on its own frame loop rather than off pointermove, because a finger parked at the
   * edge of the screen stops producing move events — and that is exactly the moment the
   * user is asking to keep going.
   */
  useEffect(() => {
    if (!drag) return;
    let frame = 0;

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const scroller = scrollerRef.current;
      if (!scroller) return;

      const rect = scroller.getBoundingClientRect();
      const x = pointerXRef.current;
      let delta = 0;
      if (x < rect.left + AUTOSCROLL_MARGIN) delta = -edgeSpeed(rect.left + AUTOSCROLL_MARGIN - x);
      else if (x > rect.right - AUTOSCROLL_MARGIN) delta = edgeSpeed(x - (rect.right - AUTOSCROLL_MARGIN));
      if (delta === 0) return;

      const before = scroller.scrollLeft;
      scroller.scrollLeft = clamp(before + delta, 0, scroller.scrollWidth - scroller.clientWidth);
      if (scroller.scrollLeft !== before) applyDrag(x);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag]);

  const applyDrag = useCallback(
    (clientX: number) => {
      const current = dragRef.current;
      if (!current) return;
      const time = toTime(clientX);

      if (current.type === 'playhead') {
        onSeek(Math.min(time, Math.max(0, total)), false);
        return;
      }

      const source = sources.find((s) => s.id === clips.find((c) => c.id === current.clipId)?.sourceId);
      if (!source) return;

      // Bounds come from the drag's origin, not the live clip, for the same reason the
      // delta does — otherwise the limit moves as the clip does.
      const bounds = trimBounds({ sourceIn: current.originIn, sourceOut: current.originOut }, source.duration);
      const deltaSource = (time - current.grabTime) * current.speed;

      if (current.edge === 'in') {
        const sourceIn = clamp(Math.round(current.originIn + deltaSource), bounds.inMin, bounds.inMax);
        lastTrimRef.current = { sourceIn, sourceOut: current.originOut };
        onTrimPreview(current.clipId, sourceIn, current.originOut);
        // Park the playhead on the clip's first frame so the preview shows the edit
        // being made rather than wherever the playhead happened to be.
        onSeek(current.start, false);
      } else {
        const sourceOut = clamp(Math.round(current.originOut + deltaSource), bounds.outMin, bounds.outMax);
        lastTrimRef.current = { sourceIn: current.originIn, sourceOut };
        onTrimPreview(current.clipId, current.originIn, sourceOut);
        const length = (sourceOut - current.originIn) / current.speed;
        onSeek(Math.max(current.start, current.start + Math.round(length) - 40_000), false);
      }
    },
    [clips, onSeek, onTrimPreview, sources, toTime, total],
  );

  const startDrag = useCallback(
    (event: React.PointerEvent, kind: DragKind) => {
      if (frozen && kind.type === 'trim') return;
      event.preventDefault();
      event.stopPropagation();
      (event.target as Element).setPointerCapture(event.pointerId);
      dragRef.current = kind;
      lastTrimRef.current = null;
      pointerXRef.current = event.clientX;
      setDrag(kind);
      // Playhead drags jump to the finger; trim drags do not. Grabbing a 3px edge with a
      // 44px target means the finger is never exactly on it, and snapping the edge to
      // wherever it landed would nudge the cut before the user moved at all.
      if (kind.type === 'playhead') applyDrag(event.clientX);
    },
    [applyDrag, frozen],
  );

  const moveDrag = useCallback(
    (event: React.PointerEvent) => {
      if (!dragRef.current) return;
      event.preventDefault();
      pointerXRef.current = event.clientX;
      applyDrag(event.clientX);
    },
    [applyDrag],
  );

  const endDrag = useCallback(
    (event: React.PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      (event.target as Element).releasePointerCapture?.(event.pointerId);
      dragRef.current = null;
      setDrag(null);

      if (current.type === 'playhead') {
        onSeek(toTime(event.clientX), true);
        return;
      }

      const pending = lastTrimRef.current;
      lastTrimRef.current = null;
      // One op for the whole gesture. Nothing moved means nothing to record.
      if (pending) onTrimCommit(current.clipId, pending.sourceIn, pending.sourceOut);
      else onTrimCancel();
    },
    [onSeek, onTrimCancel, onTrimCommit, toTime],
  );

  const zoom = (factor: number) => {
    const scroller = scrollerRef.current;
    const anchor = playhead;
    setPxPerSecond((previous) => {
      const next = clamp(previous * factor, MIN_PPS, MAX_PPS);
      if (scroller) {
        // Zoom around the playhead, not the scroll origin: the playhead is where the
        // user is looking, and zooming away from it means re-finding your place.
        requestAnimationFrame(() => {
          const x = (anchor / 1_000_000) * next + EDGE_PAD;
          scroller.scrollLeft = Math.max(0, x - scroller.clientWidth / 2);
        });
      }
      return next;
    });
  };

  const selected = clips.find((c) => c.id === selectedClipId) ?? null;
  const selectedSource = selected ? sources.find((s) => s.id === selected.sourceId) ?? null : null;

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
        <button className="icon" onClick={() => zoom(1.6)} aria-label="Zoom in" disabled={pxPerSecond >= MAX_PPS}>
          ＋
        </button>
      </div>

      <div
        className={drag ? 'timeline-scroller dragging' : 'timeline-scroller'}
        ref={scrollerRef}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="timeline-content" style={{ width: contentWidth }}>
          <Ruler total={total} pxPerSecond={pxPerSecond} onScrub={startDrag} />

          <div className="timeline-lane" onPointerDown={() => onSelect(null)}>
            {clips.map((clip, index) => (
              <ClipBlock
                key={clip.id}
                clip={clip}
                index={index}
                source={sources.find((s) => s.id === clip.sourceId) ?? null}
                mediaUrl={mediaUrls.get(clip.sourceId) ?? null}
                pxPerSecond={pxPerSecond}
                left={toX(clip.start)}
                selected={clip.id === selectedClipId}
                onSelect={() => onSelect(clip.id)}
              />
            ))}

            {selected && selectedSource && !frozen && (
              <TrimHandles
                clip={selected}
                source={selectedSource}
                pxPerSecond={pxPerSecond}
                toX={toX}
                onStart={startDrag}
                dragging={drag?.type === 'trim' ? drag.edge : null}
              />
            )}
          </div>

          <div className="playhead" style={{ left: toX(playhead) }} aria-hidden="true">
            <div className="playhead-line" />
          </div>
          {/* Its own element so the 44px grab target never overlaps a clip's tap area. */}
          <div
            className={drag?.type === 'playhead' ? 'playhead-grip active' : 'playhead-grip'}
            style={{ left: toX(playhead) }}
            onPointerDown={(event) => startDrag(event, { type: 'playhead' })}
            role="slider"
            aria-label="Playhead"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={playhead}
            tabIndex={0}
          />
        </div>
      </div>
    </section>
  );
}

function Ruler({
  total,
  pxPerSecond,
  onScrub,
}: {
  total: number;
  pxPerSecond: number;
  onScrub(event: React.PointerEvent, kind: DragKind): void;
}) {
  const step = tickInterval(pxPerSecond);
  const ticks: number[] = [];
  for (let t = 0; t <= total; t += step) ticks.push(t);

  return (
    // Scrubbing anywhere on the ruler grabs the playhead, which is how every editor
    // behaves and saves aiming for the grip itself.
    <div className="ruler" onPointerDown={(event) => onScrub(event, { type: 'playhead' })}>
      {ticks.map((t) => (
        <span key={t} className="tick" style={{ left: (t / 1_000_000) * pxPerSecond + EDGE_PAD }}>
          {formatTimecode(t, undefined, { compact: true }).replace(/\.\d+$/, '')}
        </span>
      ))}
    </div>
  );
}

function ClipBlock({
  clip,
  index,
  source,
  mediaUrl,
  pxPerSecond,
  left,
  selected,
  onSelect,
}: {
  clip: Clip;
  index: number;
  source: Source | null;
  mediaUrl: string | null;
  pxPerSecond: number;
  left: number;
  selected: boolean;
  onSelect(): void;
}) {
  const strip = useFilmstrip(clip.sourceId, mediaUrl, source?.duration ?? 0);
  const width = Math.max(8, (outputDuration(clip) / 1_000_000) * pxPerSecond);
  const classes = ['clip-block', selected ? 'selected' : '', clip.enabled ? '' : 'dropped'].filter(Boolean);

  // One thumbnail per ~64px of block, sampled from the source range this clip uses.
  const slots = Math.max(1, Math.round(width / 64));
  const thumbs = Array.from({ length: slots }, (_, i) => {
    const at = clip.sourceIn + ((i + 0.5) / slots) * (clip.sourceOut - clip.sourceIn);
    return frameAt(strip, at);
  });

  return (
    <div
      className={classes.join(' ')}
      style={{ left, width }}
      onPointerDown={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      role="button"
      aria-pressed={selected}
      aria-label={`Clip ${index + 1}, ${formatTimecode(outputDuration(clip), undefined, { compact: true })}`}
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
      <span className="clip-badge">
        {index + 1}
        {clip.speed !== 1 && <em> {clip.speed}×</em>}
        {clip.effects.length > 0 && <em> fx</em>}
        {!clip.enabled && <em> off</em>}
      </span>
    </div>
  );
}

/**
 * The trim handles, plus the ghost of the footage waiting on either side.
 *
 * The ghost is not decoration. "Drag the end to extend" is invisible otherwise — there is
 * nothing on screen to suggest the clip could get longer, or by how much. Drawing the
 * available raw footage as a dimmed extension makes the affordance and its limit the same
 * shape.
 */
function TrimHandles({
  clip,
  source,
  pxPerSecond,
  toX,
  onStart,
  dragging,
}: {
  clip: Clip;
  source: Source;
  pxPerSecond: number;
  toX(us: number): number;
  onStart(event: React.PointerEvent, kind: DragKind): void;
  dragging: 'in' | 'out' | null;
}) {
  const bounds = trimBounds(clip, source.duration);
  const px = (us: number) => (us / 1_000_000 / clip.speed) * pxPerSecond;
  const inX = toX(clip.start);
  const outX = toX(clipEnd(clip));

  return (
    <>
      {bounds.headroom.head > 0 && (
        <div className="headroom" style={{ left: inX - px(bounds.headroom.head), width: px(bounds.headroom.head) }} />
      )}
      {bounds.headroom.tail > 0 && (
        <div className="headroom" style={{ left: outX, width: px(bounds.headroom.tail) }} />
      )}

      <div
        className={dragging === 'in' ? 'trim-handle in active' : 'trim-handle in'}
        style={{ left: inX }}
        onPointerDown={(event) =>
          onStart(event, {
            type: 'trim',
            clipId: clip.id,
            edge: 'in',
            grabTime: clip.start,
            originIn: clip.sourceIn,
            originOut: clip.sourceOut,
            speed: clip.speed,
            start: clip.start,
          })
        }
        role="slider"
        aria-label="Clip start"
        aria-valuemin={bounds.inMin}
        aria-valuemax={bounds.inMax}
        aria-valuenow={clip.sourceIn}
        tabIndex={0}
      >
        <span className="grip" />
      </div>
      <div
        className={dragging === 'out' ? 'trim-handle out active' : 'trim-handle out'}
        style={{ left: outX }}
        onPointerDown={(event) =>
          onStart(event, {
            type: 'trim',
            clipId: clip.id,
            edge: 'out',
            grabTime: clipEnd(clip),
            originIn: clip.sourceIn,
            originOut: clip.sourceOut,
            speed: clip.speed,
            start: clip.start,
          })
        }
        role="slider"
        aria-label="Clip end"
        aria-valuemin={bounds.outMin}
        aria-valuemax={bounds.outMax}
        aria-valuenow={clip.sourceOut}
        tabIndex={0}
      >
        <span className="grip" />
      </div>
    </>
  );
}

/** Tick spacing that keeps labels at least ~64px apart at the current zoom. */
function tickInterval(pxPerSecond: number): number {
  const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const seconds = candidates.find((c) => c * pxPerSecond >= 64) ?? candidates.at(-1)!;
  return seconds * 1_000_000;
}

function edgeSpeed(overshoot: number): number {
  return Math.min(AUTOSCROLL_MAX_PPF, Math.max(2, overshoot / 3));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
