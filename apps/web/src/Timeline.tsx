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
  type TrimBounds,
} from '@evocut/edl';
import { frameAt, useFilmstrip } from './filmstrip.ts';

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
 * ## Touch
 *
 * Pointer Events with `setPointerCapture`, so a drag keeps receiving moves after the
 * finger leaves the element it started on. `touch-action: pan-x` on the lane so it scrolls;
 * `none` on the playhead and handles so a drag is a drag. Handles hit-test at 44px around
 * a 12px paint, because a thumb is ~9mm and a trim handle cannot be.
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
  playhead: number;
  selectedClipId: string | null;
  frozen: boolean;
  onSeek(us: number, final: boolean): void;
  onSelect(clipId: string | null): void;
  onTrimCommit(clipId: string, sourceIn: number, sourceOut: number): void;
  onDragChange(drag: TimelineDragState | null): void;
}

/** Horizontal padding inside the scroller, so the first and last frame can be reached. */
const EDGE_PAD = 24;
const MIN_PPS = 4;
const MAX_PPS = 400;
/** Within this many pixels of the edge, a *playhead* drag scrolls the lane along with it. */
const AUTOSCROLL_MARGIN = 44;
const AUTOSCROLL_MAX_PPF = 14;

interface TrimDraft {
  clipId: string;
  edge: 'in' | 'out';
  sourceIn: number;
  sourceOut: number;
  /** True when the drag is pressed against a limit, so the handle can say so. */
  clamped: boolean;
}

type DragKind =
  | { type: 'playhead' }
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
  playhead,
  selectedClipId,
  frozen,
  onSeek,
  onSelect,
  onTrimCommit,
  onDragChange,
}: TimelineProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [pxPerSecond, setPxPerSecond] = useState(40);
  const [drag, setDrag] = useState<DragKind | null>(null);
  const [draft, setDraft] = useState<TrimDraft | null>(null);
  const dragRef = useRef<DragKind | null>(null);
  const draftRef = useRef<TrimDraft | null>(null);
  const pointerXRef = useRef(0);

  const clips = timeline.tracks[0]?.clips ?? [];
  const committedTotal = timelineDuration(timeline);

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

  // Wide enough for a drag that has pushed a clip past the committed end.
  const contentWidth = Math.max(
    (committedTotal / 1_000_000) * pxPerSecond + EDGE_PAD * 2,
    ...clips.map((clip) => geometryOf(clip).left + geometryOf(clip).width + EDGE_PAD),
  );

  const fit = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller || committedTotal <= 0) return;
    const usable = Math.max(120, scroller.clientWidth - EDGE_PAD * 2);
    setPxPerSecond(clamp(usable / (committedTotal / 1_000_000), MIN_PPS, MAX_PPS));
  }, [committedTotal]);

  const fittedRef = useRef(false);
  useEffect(() => {
    if (fittedRef.current || committedTotal <= 0) return;
    fittedRef.current = true;
    fit();
  }, [fit, committedTotal]);

  // Keep the playhead on screen during playback and after a seek from elsewhere.
  useEffect(() => {
    if (drag) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;

    const x = toX(playhead);
    const left = scroller.scrollLeft;
    if (x < left + AUTOSCROLL_MARGIN || x > left + scroller.clientWidth - AUTOSCROLL_MARGIN) {
      scroller.scrollTo({ left: Math.max(0, x - scroller.clientWidth / 2), behavior: 'smooth' });
    }
  }, [playhead, toX, drag]);

  const applyDrag = useCallback(
    (clientX: number) => {
      const current = dragRef.current;
      if (!current) return;
      const time = toTime(clientX);

      if (current.type === 'playhead') {
        onSeek(Math.min(time, Math.max(0, committedTotal)), false);
        return;
      }

      const delta = (time - current.grabTime) * current.speed;
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
      onDragChange({
        kind: 'trim',
        // Show the frame at the edge being dragged. A trim is a decision about one
        // frame, and it is not reviewable without seeing it.
        scrubSourceTime: current.edge === 'in' ? next.sourceIn : Math.max(next.sourceIn, next.sourceOut - 40_000),
      });
    },
    [committedTotal, onDragChange, onSeek, toTime],
  );

  /**
   * Edge auto-scroll, for playhead drags only.
   *
   * Deliberately not applied to trims. It is the mechanism that made a stationary finger
   * keep trimming: scrolling changes the time under the finger, and a trim that responds
   * to that changes the scroll range in turn. A playhead drag has no such loop — it reads
   * the position and writes nothing that affects it.
   */
  useEffect(() => {
    if (drag?.type !== 'playhead') return;
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
  }, [drag, applyDrag]);

  const startDrag = useCallback(
    (event: React.PointerEvent, kind: DragKind) => {
      if (frozen && kind.type === 'trim') return;
      event.preventDefault();
      event.stopPropagation();
      (event.target as Element).setPointerCapture?.(event.pointerId);

      dragRef.current = kind;
      draftRef.current = null;
      pointerXRef.current = event.clientX;
      setDrag(kind);
      setDraft(null);

      if (kind.type === 'playhead') {
        onDragChange({ kind: 'playhead' });
        applyDrag(event.clientX);
      } else {
        // No `applyDrag` here. The finger is somewhere inside a 44px target around a 12px
        // handle, so acting on pointerdown would nudge the cut before the user moved.
        onDragChange({
          kind: 'trim',
          scrubSourceTime: kind.edge === 'in' ? kind.originIn : Math.max(kind.originIn, kind.originOut - 40_000),
        });
      }
    },
    [applyDrag, frozen, onDragChange],
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

      const pending = draftRef.current;
      dragRef.current = null;
      draftRef.current = null;
      setDrag(null);
      setDraft(null);
      onDragChange(null);

      if (current.type === 'playhead') {
        onSeek(toTime(event.clientX), true);
      } else if (pending) {
        // One op for the whole gesture.
        onTrimCommit(current.clipId, pending.sourceIn, pending.sourceOut);
      }
    },
    [onDragChange, onSeek, onTrimCommit, toTime],
  );

  const zoom = (factor: number) => {
    const scroller = scrollerRef.current;
    const anchor = playhead;
    setPxPerSecond((previous) => {
      const next = clamp(previous * factor, MIN_PPS, MAX_PPS);
      if (scroller) {
        // Zoom around the playhead: it is where the user is looking, and zooming away
        // from it means re-finding your place.
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
          <Ruler total={committedTotal} pxPerSecond={pxPerSecond} onScrub={startDrag} />

          <div className="timeline-lane" onPointerDown={() => onSelect(null)}>
            {clips.map((clip, index) => (
              <ClipBlock
                key={clip.id}
                clip={clip}
                index={index}
                source={sources.find((s) => s.id === clip.sourceId) ?? null}
                mediaUrl={mediaUrls.get(clip.sourceId) ?? null}
                geometry={geometryOf(clip)}
                draft={draft?.clipId === clip.id ? draft : null}
                selected={clip.id === selectedClipId}
                onSelect={() => onSelect(clip.id)}
              />
            ))}

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
            aria-valuemax={committedTotal}
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
  geometry,
  draft,
  selected,
  onSelect,
}: {
  clip: Clip;
  index: number;
  source: Source | null;
  mediaUrl: string | null;
  geometry: { left: number; width: number };
  draft: TrimDraft | null;
  selected: boolean;
  onSelect(): void;
}) {
  const strip = useFilmstrip(clip.sourceId, mediaUrl, source?.duration ?? 0);
  const sourceIn = draft ? draft.sourceIn : clip.sourceIn;
  const sourceOut = draft ? draft.sourceOut : clip.sourceOut;
  const classes = ['clip-block', selected ? 'selected' : '', clip.enabled ? '' : 'dropped', draft ? 'trimming' : '']
    .filter(Boolean)
    .join(' ');

  // One thumbnail per ~56px of block, sampled across the range the clip currently uses,
  // so the strip re-aims as the edge moves instead of stretching.
  const slots = Math.max(1, Math.round(geometry.width / 56));
  const thumbs = Array.from({ length: slots }, (_, i) =>
    frameAt(strip, sourceIn + ((i + 0.5) / slots) * (sourceOut - sourceIn)),
  );

  return (
    <div
      className={classes}
      style={{ left: geometry.left, width: geometry.width }}
      onPointerDown={(event) => {
        event.stopPropagation();
        onSelect();
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
}

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
