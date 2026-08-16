import { useCallback, useRef, useState } from 'react';
import { NEUTRAL_COLOR, isNeutralColor, type ColorValue } from '@evocut/edl';
import { autoColor, measureFrame } from '@evocut/renderer';

/**
 * Colour and tone, for one clip or for all of them.
 *
 * ## The sheet is short on purpose
 *
 * A colour control you cannot see the result of is a set of numbers. This sheet is capped
 * at just over half the screen so the preview above it stays visible, and every change
 * shows there immediately — the draft is held here and handed to the player, which paints
 * it with the same `filter` string the export will use. Nothing reaches the EDL until Done.
 *
 * ## Auto
 *
 * Reads the frame that is on screen and proposes a grade for it. It is a starting point
 * that lands on the same sliders, not a mode — so it can be nudged, and it can be undone
 * by dragging rather than by finding a way back out of it.
 *
 * The frame it reads is the *ungraded* one: a CSS filter is a rendering effect and does not
 * change what `drawImage` copies out of the element, so tapping Auto twice cannot spiral.
 *
 * ## Apply to all
 *
 * The reason this feature exists on a phone. Footage shot in one room over an hour drifts —
 * the camera re-balances every time someone walks past a window — and fifty-one clips that
 * were each adjusted individually look worse than fifty-one that share one grade. It is one
 * revision, so it is one undo.
 */
export interface AdjustProps {
  /** The clip being adjusted, for the heading. Null when the playhead is past the end. */
  clipNumber: number | null;
  clipCount: number;
  value: ColorValue;
  /** The live element, so Auto can read the frame that is actually on screen. */
  videoFor(): HTMLVideoElement | null;
  onChange(value: ColorValue): void;
  onCommit(value: ColorValue | null): void;
  onApplyToAll(value: ColorValue | null): void;
  onClose(): void;
}

interface Control {
  key: keyof ColorValue;
  label: string;
  /** What each end of the slider does, so the name does not have to carry it alone. */
  low: string;
  high: string;
}

const CONTROLS: Control[] = [
  { key: 'exposure', label: 'Exposure', low: 'darker', high: 'brighter' },
  { key: 'brilliance', label: 'Brilliance', low: 'deeper', high: 'open the shadows' },
  { key: 'contrast', label: 'Contrast', low: 'flatter', high: 'punchier' },
  { key: 'saturation', label: 'Saturation', low: 'muted', high: 'vivid' },
  { key: 'warmth', label: 'Warmth', low: 'cooler', high: 'warmer' },
  { key: 'tint', label: 'Tint', low: 'green', high: 'magenta' },
];

/** Width the frame is measured at. Enough pixels for a histogram, few enough to be free. */
const SAMPLE_WIDTH = 128;

export function AdjustSheet({
  clipNumber,
  clipCount,
  value,
  videoFor,
  onChange,
  onCommit,
  onApplyToAll,
  onClose,
}: AdjustProps) {
  const [note, setNote] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  /*
    Controlled, with the draft living one level up.

    It was a local `useState` mirrored to the parent through an effect, which is the shape
    that produces "Maximum update depth exceeded": the parent's `onChange` is a new closure
    on every render, so the effect that reported the draft re-ran on every render it had
    just caused. One copy of the value, written directly, cannot do that.
  */
  const set = useCallback(
    (key: keyof ColorValue, amount: number) => {
      setNote(null);
      onChange({ ...value, [key]: amount });
    },
    [onChange, value],
  );

  const auto = useCallback(() => {
    const video = videoFor();
    if (!video || video.videoWidth === 0) {
      setNote('No frame to read yet — let the preview load, then try again.');
      return;
    }

    const canvas = (canvasRef.current ??= document.createElement('canvas'));
    const height = Math.max(1, Math.round((SAMPLE_WIDTH * video.videoHeight) / video.videoWidth));
    canvas.width = SAMPLE_WIDTH;
    canvas.height = height;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      setNote('This browser will not let the frame be read.');
      return;
    }

    try {
      ctx.drawImage(video, 0, 0, SAMPLE_WIDTH, height);
      const pixels = ctx.getImageData(0, 0, SAMPLE_WIDTH, height).data;
      const proposed = autoColor(measureFrame(pixels));
      onChange(proposed);
      setNote(
        isNeutralColor(proposed)
          ? 'This frame already looks about right — nothing to change.'
          : 'Adjusted from the frame on screen. Nudge anything that went too far.',
      );
    } catch {
      // A tainted canvas: the media came from somewhere this page may not read pixels
      // from. Nothing is broken, the sliders still work, and saying so beats a dead button.
      setNote('This video will not let its pixels be read, so Auto is unavailable here.');
    }
  }, [onChange, videoFor]);

  const touched = !isNeutralColor(value);

  return (
    <div className="sheet adjust" role="dialog" aria-label="Adjust">
      <div className="sheet-head">
        <button className="close" onClick={onClose} aria-label="Close">
          ✕
        </button>
        <span className="sheet-count">
          Adjust{clipNumber === null ? '' : ` · clip ${clipNumber} of ${clipCount}`}
        </span>
        <button className="primary small auto" onClick={auto}>
          Auto
        </button>
      </div>

      <div className="sliders">
        {CONTROLS.map((control) => (
          <label key={control.key} className="slider">
            <span className="slider-name">
              {control.label}
              <em>{format(value[control.key])}</em>
            </span>
            <input
              type="range"
              min={-100}
              max={100}
              step={1}
              value={Math.round(value[control.key] * 100)}
              onChange={(event) => set(control.key, Number(event.target.value) / 100)}
              aria-label={`${control.label}, ${control.low} to ${control.high}`}
            />
          </label>
        ))}
      </div>

      {note && <p className="meta">{note}</p>}

      <div className="sheet-actions">
        <button onClick={() => onChange({ ...NEUTRAL_COLOR })} disabled={!touched}>
          Reset
        </button>
        <button
          onClick={() => onApplyToAll(touched ? value : null)}
          disabled={clipCount < 2}
        >
          Apply to all
        </button>
        <button className="primary" onClick={() => onCommit(touched ? value : null)}>
          Done
        </button>
      </div>
      <p className="meta">
        “Apply to all” puts this exact adjustment on every clip in the timeline, so footage
        shot over an hour in one room ends up matching.
      </p>
    </div>
  );
}

/** −100…+100, with a sign, because the sign is the whole reading. */
function format(amount: number): string {
  const percent = Math.round(amount * 100);
  return percent === 0 ? '0' : `${percent > 0 ? '+' : ''}${percent}`;
}
