import { formatTimecode, type OpPreview } from '@evocut/edl';

/**
 * Every suggestion in one list.
 *
 * The bubbles on the timeline answer "what is being suggested *here*"; this answers "what
 * is being suggested at all", and the two are genuinely different questions. A pass that
 * returns forty edits is unreadable as forty bubbles and perfectly readable as a list with
 * a running total at the bottom.
 *
 * This is no longer a screen you have to get through. It used to be modal — the timeline
 * disappeared, you ticked boxes against text, and one Apply button committed the lot. That
 * arrangement forced every judgement to be made blind and in one sitting. Now nothing here
 * is a commitment: each row is a live toggle against the edit behind it, and the list can
 * be closed and reopened as many times as it takes.
 *
 * What survives from the old design, because it was right:
 *
 *  - **Nothing starts accepted.** A list that opens pre-ticked collects consent, not
 *    judgement, and consent is worth nothing as a training label.
 *  - **Every suggestion shows its rationale.** The model's stated reason is being judged
 *    as much as the edit is.
 *  - **Rejections are recorded.** A skipped op leaves no mark on the timeline, so the
 *    verdict is the only trace it will ever have.
 */
export interface ReviewProps {
  previews: OpPreview[];
  accepted: boolean[];
  failures: Map<number, string>;
  by: 'model' | 'heuristics';
  model: string | null;
  summary: string | null;
  /** Where the edit stands against its target, if one is set. */
  standing: string;
  onOpen(index: number): void;
  onVerdict(index: number, accepted: boolean): void;
  onAll(accepted: boolean): void;
  onFinish(): void;
  onDiscard(): void;
  onClose(): void;
}

export function Review({
  previews,
  accepted,
  failures,
  by,
  model,
  summary,
  standing,
  onOpen,
  onVerdict,
  onAll,
  onFinish,
  onDiscard,
  onClose,
}: ReviewProps) {
  const keptCount = accepted.filter(Boolean).length;
  const keptUs = previews.reduce(
    (total, preview, index) => total + (accepted[index] && preview.applicable ? preview.deltaUs : 0),
    0,
  );

  if (previews.length === 0) {
    return (
      <section className="sheet review" role="dialog" aria-label="All suggestions">
        <h2>Nothing to change</h2>
        <p className="lede">{summary ?? 'The pass came back with no suggestions.'}</p>
        <button className="primary" onClick={onDiscard}>
          Back to the timeline
        </button>
      </section>
    );
  }

  return (
    <section className="sheet review" role="dialog" aria-label="All suggestions">
      <div className="sheet-head">
        <button className="close" onClick={onClose} aria-label="Close">
          ✕
        </button>
        <span className="sheet-count">
          {previews.length} {previews.length === 1 ? 'suggestion' : 'suggestions'} ·{' '}
          {by === 'model' ? model ?? 'a model' : 'built-in heuristics'}
        </span>
      </div>

      {summary && <p className="lede">{summary}</p>}

      <div className="review-bulk">
        <button className="ghost" onClick={() => onAll(true)}>
          Keep all
        </button>
        <button className="ghost" onClick={() => onAll(false)}>
          Skip all
        </button>
      </div>

      <ol className="proposals">
        {previews.map((preview, index) => {
          const on = accepted[index] ?? false;
          const failure = failures.get(index);
          return (
            <li key={index} className={['proposal', on ? 'accepted' : '', failure ? 'stale' : ''].filter(Boolean).join(' ')}>
              <button className="proposal-body" onClick={() => onOpen(index)}>
                <strong>{preview.headline}</strong>
                <span className="proposal-at">
                  at {formatTimecode(preview.anchorUs, undefined, { compact: true })}
                  {preview.deltaUs !== 0 && ` · ${preview.deltaUs > 0 ? '+' : ''}${(preview.deltaUs / 1_000_000).toFixed(2)}s`}
                </span>
                {preview.op.rationale && <small>{preview.op.rationale}</small>}
                {failure && <small className="warning">No longer applies: {failure}</small>}
              </button>
              <div className="proposal-verdict">
                <button
                  className={on ? 'verdict on' : 'verdict'}
                  onClick={() => onVerdict(index, true)}
                  aria-pressed={on}
                  aria-label={`Keep suggestion ${index + 1}`}
                >
                  Keep
                </button>
                <button
                  className={on ? 'verdict' : 'verdict on'}
                  onClick={() => onVerdict(index, false)}
                  aria-pressed={!on}
                  aria-label={`Skip suggestion ${index + 1}`}
                >
                  Skip
                </button>
              </div>
            </li>
          );
        })}
      </ol>

      <p className="meta">
        Keeping {keptCount} of {previews.length}
        {keptUs !== 0 && `, ${keptUs < 0 ? 'saving' : 'adding'} ${formatTimecode(Math.abs(keptUs), undefined, { compact: true })}`}
        {' · '}
        {standing}
      </p>

      <div className="review-actions">
        {/*
          Finishing with nothing kept is a real outcome, not a no-op: it records that a
          human saw these suggestions and wanted none of them, which is a stronger signal
          than never having asked. Discarding throws the verdicts away with them.
        */}
        <button className="ghost danger" onClick={onDiscard}>
          Discard the pass
        </button>
        <button className="primary" onClick={onFinish}>
          {keptCount === 0 ? 'Done — kept none' : `Done — kept ${keptCount}`}
        </button>
      </div>
    </section>
  );
}
