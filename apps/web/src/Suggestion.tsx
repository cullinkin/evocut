import {
  formatTimecode,
  outputDuration,
  type Clip,
  type OpPreview,
  type Source,
} from '@evocut/edl';
import { frameAt, useFilmstrip } from './filmstrip.ts';

/**
 * One suggestion, shown as what it does rather than as what it is.
 *
 * A table of op names was the first version of this and it was close to useless. "trim
 * clp_0qk2… sourceOut 2240000" is precise, unreadable, and — the actual problem — gives a
 * person no way to tell a good edit from a bad one without applying it and watching.
 * Deciding needs to be cheaper than trying, or the review screen is just a slower undo.
 *
 * So the shot is drawn twice, at the same scale, from the same filmstrip:
 *
 *  - **Both bars are laid out in output seconds.** A trim that removes half a second
 *    produces a bar that is visibly half a second shorter. That single property does more
 *    than any wording: the change has a size, and it is the size on screen.
 *  - **What goes is drawn where it was**, hatched at the head or the tail rather than
 *    simply absent, so "off the front" and "off the back" are distinguishable at a glance.
 *  - **The frames are real.** They come from the same cached filmstrip the timeline uses,
 *    aimed at the range each version of the clip would actually play, so the "after" bar
 *    starts on the frame the edit would start on. That is the thing being judged.
 *
 * Underneath, the two numbers that decide it in practice: what this costs, and where the
 * whole video lands if it is kept.
 */
export interface SuggestionProps {
  preview: OpPreview;
  index: number;
  count: number;
  accepted: boolean;
  source: Source | null;
  mediaUrl: string | null;
  /** Whole-timeline length now, and if this suggestion is kept. */
  totalUs: number;
  standing: string;
  failure: string | null;
  onVerdict(accepted: boolean): void;
  onStep(delta: number): void;
  onClose(): void;
}

export function SuggestionSheet({
  preview,
  index,
  count,
  accepted,
  source,
  mediaUrl,
  totalUs,
  standing,
  failure,
  onVerdict,
  onStep,
  onClose,
}: SuggestionProps) {
  // The longer of the two, so the pair share a scale and the shorter one looks shorter.
  const scaleUs = Math.max(preview.beforeLengthUs, preview.afterLengthUs, 1);

  return (
    <div className="sheet" role="dialog" aria-label="Suggested edit">
      <div className="sheet-head">
        <button className="ghost small" onClick={onClose} aria-label="Close">
          ✕
        </button>
        <span className="sheet-count">
          {index + 1} of {count}
        </span>
        <span className="timeline-spacer" />
        <button className="ghost small" onClick={() => onStep(-1)} disabled={count < 2} aria-label="Previous suggestion">
          ‹
        </button>
        <button className="ghost small" onClick={() => onStep(1)} disabled={count < 2} aria-label="Next suggestion">
          ›
        </button>
      </div>

      <h2>{preview.headline}</h2>
      {preview.op.rationale && <p className="rationale">“{preview.op.rationale}”</p>}

      {failure ? (
        <p className="warning">This no longer applies: {failure}</p>
      ) : (
        <div className="compare">
          <ShotBar
            label="Now"
            clip={preview.before}
            source={source}
            mediaUrl={mediaUrl}
            lengthUs={preview.beforeLengthUs}
            scaleUs={scaleUs}
            cut={null}
          />
          <ShotBar
            label="After"
            clip={preview.after}
            source={source}
            mediaUrl={mediaUrl}
            lengthUs={preview.afterLengthUs}
            scaleUs={scaleUs}
            cut={cutOf(preview)}
          />
        </div>
      )}

      <dl className="cost">
        <div>
          <dt>This shot</dt>
          <dd>
            {seconds(preview.beforeLengthUs)} → {seconds(preview.afterLengthUs)}
          </dd>
        </div>
        <div>
          <dt>Whole video</dt>
          <dd>
            {formatTimecode(totalUs, undefined, { compact: true })} →{' '}
            {formatTimecode(totalUs + (accepted ? 0 : preview.deltaUs), undefined, { compact: true })}
          </dd>
        </div>
      </dl>
      <p className="meta">{standing}</p>

      <div className="sheet-actions">
        {/*
          "Put it back" rather than "Skip" once something is accepted. The two states are
          the same toggle, but the words a person needs are different: one is a decision,
          the other is a reversal, and calling both of them Skip hides the fact that
          reversing is available at all.
        */}
        <button
          className={accepted ? 'ghost danger' : 'ghost'}
          onClick={() => onVerdict(false)}
          aria-pressed={!accepted}
        >
          {accepted ? 'Put it back' : 'Skip'}
        </button>
        <button className={accepted ? 'primary on' : 'primary'} onClick={() => onVerdict(true)} aria-pressed={accepted}>
          {accepted ? 'Kept' : 'Keep'}
        </button>
      </div>
    </div>
  );
}

/** Which end of the shot this op takes off, as fractions of the "before" length. */
function cutOf(preview: OpPreview): { head: number; tail: number } | null {
  const { before, after, op } = preview;
  if (!before || !after) return null;
  if (op.op !== 'trim') return null;

  const span = before.sourceOut - before.sourceIn;
  if (span <= 0) return null;
  return {
    head: Math.max(0, (after.sourceIn - before.sourceIn) / span),
    tail: Math.max(0, (before.sourceOut - after.sourceOut) / span),
  };
}

/**
 * One version of the shot, drawn from the filmstrip.
 *
 * Width is proportional to *output* length, so a speed-up shortens the bar even though it
 * plays the same frames — which is the whole content of a speed suggestion and the part a
 * frame-by-frame view would hide.
 */
function ShotBar({
  label,
  clip,
  source,
  mediaUrl,
  lengthUs,
  scaleUs,
  cut,
}: {
  label: string;
  clip: Clip | null;
  source: Source | null;
  mediaUrl: string | null;
  lengthUs: number;
  scaleUs: number;
  cut: { head: number; tail: number } | null;
}) {
  const strip = useFilmstrip(clip?.sourceId ?? null, mediaUrl, source?.duration ?? 0);

  if (!clip || lengthUs <= 0) {
    return (
      <div className="shot">
        <span className="shot-label">{label}</span>
        <div className="shot-track">
          <div className="shot-bar empty">gone</div>
        </div>
        <span className="shot-length">—</span>
      </div>
    );
  }

  const slots = 6;
  const thumbs = Array.from({ length: slots }, (_, i) =>
    frameAt(strip, clip.sourceIn + ((i + 0.5) / slots) * (clip.sourceOut - clip.sourceIn)),
  );

  return (
    <div className="shot">
      <span className="shot-label">{label}</span>
      {/*
        The bar's percentage is of this track, not of the row. Sizing it against the row
        would include the label and the length readout, so a 100% bar — the longer of the
        pair, always — would overflow by exactly those two columns.
      */}
      <div className="shot-track">
        <div className="shot-bar" style={{ width: `${Math.max(8, (lengthUs / scaleUs) * 100)}%` }}>
          {thumbs.map((frame, i) =>
            frame ? <img key={i} src={frame.url} alt="" draggable={false} /> : <span key={i} className="thumb-placeholder" />,
          )}
          {/* Drawn over the kept frames at the end it came off, so the direction is visible. */}
          {cut && cut.head > 0 && <span className="shot-cut head" style={{ width: `${cut.head * 100}%` }} />}
          {cut && cut.tail > 0 && <span className="shot-cut tail" style={{ width: `${cut.tail * 100}%` }} />}
        </div>
      </div>
      <span className="shot-length">{seconds(outputDuration(clip))}</span>
    </div>
  );
}

function seconds(us: number): string {
  return `${(us / 1_000_000).toFixed(2)}s`;
}
