import { formatTimecode } from '@evocut/edl';

/**
 * How fast a clip plays.
 *
 * ## Why the slider is bent
 *
 * The useful range is not the whole range. Almost every speed change in a real edit lives
 * between 0.5× and 3× — a walk-over nudged along, a reveal held back — and the difference
 * between 1.2× and 1.3× matters, while the difference between 14× and 15× does not. A
 * linear 0.1–20 slider gives the entire interesting band about a quarter of an inch of
 * travel and the rest of the track to speeds nobody picks deliberately.
 *
 * So it is piecewise: four fifths of the track covers 0.1× to 5×, and the last fifth
 * covers 5× to 20×. Same two ends, and the part you actually aim at is where your thumb is.
 *
 * ## The number that matters is the length
 *
 * Nobody wants 1.7×. They want the shot two seconds shorter. Both are on screen, and the
 * resulting length is the larger of the two.
 *
 * ## No undo here
 *
 * The other panels carry undo and redo over their drafts, because a grade is six values and
 * a move is a list. This is one number with a visible Reset and a row of exact marks, and
 * an undo for it would be a button that does what the 1× mark already does.
 */
export interface SpeedProps {
  clipNumber: number | null;
  /** Source length of the clip, so the resulting output length can be shown. */
  sourceDurationUs: number;
  value: number;
  onChange(speed: number): void;
  onCommit(speed: number): void;
  onClose(): void;
}

export const MIN_SPEED = 0.1;
export const MAX_SPEED = 20;
/** Where the slider changes gear: 5× sits four fifths of the way along. */
const KNEE_SPEED = 5;
const KNEE_AT = 0.8;
/** Slider steps. A thousand puts ~0.006× between stops in the fine half. */
const STEPS = 1000;

/** Slider position (0..1) to a speed. */
export function speedAt(position: number): number {
  const t = Math.max(0, Math.min(1, position));
  const raw =
    t <= KNEE_AT
      ? MIN_SPEED + ((KNEE_SPEED - MIN_SPEED) * t) / KNEE_AT
      : KNEE_SPEED + ((MAX_SPEED - KNEE_SPEED) * (t - KNEE_AT)) / (1 - KNEE_AT);
  // Two decimals below the knee, one above it: 1.25x is a real choice, 12.5x is not.
  return raw <= KNEE_SPEED ? Math.round(raw * 100) / 100 : Math.round(raw * 10) / 10;
}

/** The inverse, for putting the handle where the clip's current speed is. */
export function positionOf(speed: number): number {
  const clamped = Math.max(MIN_SPEED, Math.min(MAX_SPEED, speed));
  return clamped <= KNEE_SPEED
    ? ((clamped - MIN_SPEED) / (KNEE_SPEED - MIN_SPEED)) * KNEE_AT
    : KNEE_AT + ((clamped - KNEE_SPEED) / (MAX_SPEED - KNEE_SPEED)) * (1 - KNEE_AT);
}

/** The speeds worth a labelled tick, in the order they sit on the track. */
const MARKS = [0.25, 0.5, 1, 2, 5, 10, 20];

export function SpeedPanel({
  clipNumber,
  sourceDurationUs,
  value,
  onChange,
  onCommit,
  onClose,
}: SpeedProps) {
  const outputUs = Math.round(sourceDurationUs / Math.max(MIN_SPEED, value));

  return (
    <section className="panel speed" aria-label="Speed">
      <div className="panel-top">
        <span className="speed-readout">
          <strong>{value}×</strong>
        </span>
        <span className="panel-title">
          {clipNumber === null ? 'Speed' : `Clip ${clipNumber}`}
          <em>
            {formatTimecode(sourceDurationUs, undefined, { compact: true })} →{' '}
            {formatTimecode(outputUs, undefined, { compact: true })}
          </em>
        </span>
        <button className="close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <label className="slider wide">
        <input
          type="range"
          min={0}
          max={STEPS}
          step={1}
          value={Math.round(positionOf(value) * STEPS)}
          onChange={(event) => onChange(speedAt(Number(event.target.value) / STEPS))}
          aria-label="Speed, 0.1 times to 20 times"
        />
      </label>
      <div className="speed-marks">
        {MARKS.map((mark) => (
          <button
            key={mark}
            className={Math.abs(value - mark) < 0.005 ? 'tick on' : 'tick'}
            style={{ left: `${positionOf(mark) * 100}%` }}
            onClick={() => onChange(mark)}
          >
            {mark}×
          </button>
        ))}
      </div>

      <div className="panel-actions">
        <button className="ghost" onClick={() => onChange(1)} disabled={value === 1}>
          Reset
        </button>
        <button className="primary confirm" onClick={() => onCommit(value)} aria-label="Done">
          ✓
        </button>
      </div>
    </section>
  );
}
