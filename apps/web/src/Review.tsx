import { describeOp, type RefinementPlan, type Timeline } from '@evocut/edl';

/**
 * The refinement review screen.
 *
 * This is where usage becomes labelled data, and the design follows from that:
 *
 *  - **Nothing starts accepted.** A screen that opens with every box ticked collects
 *    consent, not judgement, and consent is worth nothing as a training label.
 *  - **Every op shows its rationale.** The model's stated reason is the thing being
 *    judged as much as the edit is; an edit with no reason attached cannot be evaluated,
 *    only guessed at.
 *  - **Rejections are recorded, not discarded.** A rejected op leaves no mark on the
 *    timeline, so the verdict is the only trace it ever gets.
 *
 * One op per row, each independently decidable. Batch buttons exist, but they are
 * secondary — the per-op verdict is the product.
 */
export interface ReviewProps {
  plan: RefinementPlan;
  timeline: Timeline;
  verdicts: Map<number, boolean>;
  busy: boolean;
  onVerdict(index: number, accepted: boolean): void;
  onAll(accepted: boolean): void;
  onApply(): void;
  onDiscard(): void;
}

export function Review({ plan, timeline, verdicts, busy, onVerdict, onAll, onApply, onDiscard }: ReviewProps) {
  const acceptedCount = [...verdicts.values()].filter(Boolean).length;

  if (plan.ops.length === 0) {
    return (
      <section className="review">
        <h2>Nothing to change</h2>
        <p className="lede">{plan.summary}</p>
        <button className="primary" onClick={onDiscard}>
          Back to the timeline
        </button>
      </section>
    );
  }

  return (
    <section className="review">
      <h2>Suggested edits</h2>
      {plan.summary && <p className="lede">{plan.summary}</p>}

      <div className="review-bulk">
        <button className="ghost" onClick={() => onAll(true)}>
          Accept all
        </button>
        <button className="ghost" onClick={() => onAll(false)}>
          Reject all
        </button>
      </div>

      <ol className="proposals">
        {plan.ops.map((op, index) => {
          const accepted = verdicts.get(index) ?? false;
          return (
            <li key={index} className={accepted ? 'proposal accepted' : 'proposal'}>
              <div className="proposal-body">
                <strong>{describeOp(op, timeline)}</strong>
                {op.rationale && <small>{op.rationale}</small>}
              </div>
              <div className="proposal-verdict">
                <button
                  className={accepted ? 'verdict on' : 'verdict'}
                  onClick={() => onVerdict(index, true)}
                  aria-pressed={accepted}
                >
                  Keep
                </button>
                <button
                  className={accepted ? 'verdict' : 'verdict on'}
                  onClick={() => onVerdict(index, false)}
                  aria-pressed={!accepted}
                >
                  Skip
                </button>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="review-actions">
        <button className="ghost" onClick={onDiscard} disabled={busy}>
          Cancel
        </button>
        <button className="primary" onClick={onApply} disabled={busy}>
          {acceptedCount === 0
            ? 'Reject the whole pass'
            : `Apply ${acceptedCount} of ${plan.ops.length}`}
        </button>
      </div>

      {/*
        Applying with nothing accepted is a real outcome, not a no-op: it records that a
        human saw these suggestions and wanted none of them, which is a stronger signal
        than never having asked.
      */}
    </section>
  );
}
