import { useCallback, useRef, useState } from 'react';
import { NEUTRAL_COLOR, isNeutralColor, type ColorValue } from '@evocut/edl';
import { autoColor, measureFrame } from '@evocut/renderer';
import { PanelHistory, PanelTabs, useDraftHistory } from './panel.tsx';

/**
 * Colour and tone, for one clip or for all of them.
 *
 * ## One control at a time
 *
 * This was six sliders in a bottom sheet, which covered the timeline and took most of the
 * screen — so you were grading a picture you could barely see, with no way to move to the
 * next shot without closing it. It is a panel now: it takes the toolbar's place under the
 * timeline, the preview keeps its full height, and the six controls live behind a tab strip
 * so only one slider is ever on screen. Scrub to another clip and the panel follows.
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

export function AdjustPanel({
  clipNumber,
  clipCount,
  value,
  videoFor,
  onChange,
  onCommit,
  onApplyToAll,
  onClose,
}: AdjustProps) {
  const [tab, setTab] = useState<keyof ColorValue>('exposure');
  const [note, setNote] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const history = useDraftHistory(value, onChange);

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
      history.remember(value);
      onChange({ ...value, [key]: amount });
    },
    [history, onChange, value],
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
      history.remember(value);
      onChange(proposed);
      setNote(
        isNeutralColor(proposed)
          ? 'This frame already looks about right.'
          : 'Adjusted from the frame on screen.',
      );
    } catch {
      // A tainted canvas: the media came from somewhere this page may not read pixels
      // from. Nothing is broken, the sliders still work, and saying so beats a dead button.
      setNote('This video will not let its pixels be read, so Auto is unavailable here.');
    }
  }, [history, onChange, value, videoFor]);

  const touched = !isNeutralColor(value);
  const control = CONTROLS.find((entry) => entry.key === tab) ?? CONTROLS[0]!;

  return (
    <section className="panel adjust" aria-label="Adjust">
      <div className="panel-top">
        <button className="close" onClick={onClose} aria-label="Close">
          ✕
        </button>
        <button className="primary small auto" onClick={auto}>
          Auto
        </button>
        <span className="panel-title">
          {clipNumber === null ? 'Adjust' : `Clip ${clipNumber}`}
        </span>
        <PanelHistory {...history} what="adjustment" />
        <button
          className="ghost small"
          onClick={() => onApplyToAll(touched ? value : null)}
          disabled={clipCount < 2}
          aria-label="Apply to all clips"
        >
          All
        </button>
        <button
          className="ghost small"
          onClick={() => {
            history.remember(value);
            onChange({ ...NEUTRAL_COLOR });
          }}
          disabled={!touched}
        >
          Reset
        </button>
        <button
          className="primary confirm"
          onClick={() => onCommit(touched ? value : null)}
          aria-label="Done"
        >
          ✓
        </button>
      </div>

      <PanelTabs
        tabs={CONTROLS.map((entry) => ({ id: entry.key, label: entry.label }))}
        active={tab}
        onPick={setTab}
      />

      <div className="sliders">
        <label className="slider">
          <span className="slider-name">
            <small>{note ?? `${control.low} · ${control.high}`}</small>
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
      </div>

    </section>
  );
}

/** −100…+100, with a sign, because the sign is the whole reading. */
function format(amount: number): string {
  const percent = Math.round(amount * 100);
  return percent === 0 ? '0' : `${percent > 0 ? '+' : ''}${percent}`;
}
