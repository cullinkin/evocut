import { useCallback, useMemo } from 'react';
import { formatTimecode, sampleTransform, type Easing, type TransformValue } from '@evocut/edl';

/**
 * Framing over time: zoom, pan and rotation, keyframed.
 *
 * ## The flow this is built around
 *
 * Drop a keyframe, move forward, change the framing — and the change lands as a second
 * keyframe rather than as an edit to the first. That is how every editor does it and it is
 * the only version that lets you build a move without thinking about the data structure.
 * Here it means: once a clip has any keyframes at all, adjusting a slider at a time that
 * has none *creates* one, carrying the values you just set and leaving everything before
 * it alone.
 *
 * ## Its own scrubber
 *
 * A bottom sheet covers the timeline, so a sheet that needed the timeline to move through
 * the clip would be a sheet you had to keep closing. The strip below is the clip — not the
 * edit — with the keyframes drawn on it, which is also the right scale: keyframe times are
 * clip-relative, and a two-second shot inside a nine-minute assembly is invisible on the
 * timeline and the whole world in here.
 *
 * Moving it moves the app's playhead too, so the preview above shows the frame being
 * framed.
 *
 * ## Nothing is committed until Done
 *
 * The whole keyframe list is the draft, held one level up and handed to the player, which
 * paints it with the same function the export uses. One op lands at the end — `setTransform`
 * replaces the clip's framing outright — so a minute of fiddling is one undo.
 */
export interface Keyframe {
  t: number;
  value: TransformValue;
  easing: Easing;
}

export interface TransformProps {
  clipNumber: number | null;
  /** Output length of the clip, which is the scrubber's full extent. */
  durationUs: number;
  /** Where the playhead is *within the clip*. */
  atUs: number;
  keyframes: Keyframe[];
  onSeekWithin(us: number): void;
  onChange(keyframes: Keyframe[]): void;
  onCommit(keyframes: Keyframe[] | null): void;
  onClose(): void;
}

interface Control {
  key: keyof TransformValue;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Slider units per unit of value, so a fraction can be shown as a percentage. */
  scale: number;
  suffix: string;
}

const CONTROLS: Control[] = [
  { key: 'scale', label: 'Zoom', min: 50, max: 400, step: 1, scale: 100, suffix: '%' },
  { key: 'x', label: 'Pan across', min: -100, max: 100, step: 1, scale: 100, suffix: '%' },
  { key: 'y', label: 'Pan up/down', min: -100, max: 100, step: 1, scale: 100, suffix: '%' },
  { key: 'rotation', label: 'Rotation', min: -180, max: 180, step: 1, scale: 1, suffix: '°' },
];

export const IDENTITY: TransformValue = { scale: 1, x: 0, y: 0, rotation: 0 };

/** How close two keyframes have to be to count as the same one. Two frames at 30fps. */
const SAME_TIME_US = 66_000;

/** The framing at `atUs`, whether or not a keyframe sits there. */
export function valueAt(keyframes: Keyframe[], atUs: number): TransformValue {
  if (keyframes.length === 0) return { ...IDENTITY };
  return sampleTransform(keyframes, atUs);
}

/** The keyframe at `atUs`, if there is one. */
export function keyframeAt(keyframes: Keyframe[], atUs: number): Keyframe | null {
  return keyframes.find((keyframe) => Math.abs(keyframe.t - atUs) <= SAME_TIME_US) ?? null;
}

/**
 * Write a value in at `atUs`, replacing the keyframe there or adding one.
 *
 * The auto-keyframe rule lives here rather than in the component so it can be reasoned
 * about on its own: an empty list gets a single keyframe (a static reframe, no move); a
 * list that already has keyframes gets a new one at this instant, which is what makes
 * "move forward, adjust" build a move instead of rewriting the one that exists.
 */
export function writeAt(keyframes: Keyframe[], atUs: number, value: TransformValue): Keyframe[] {
  const existing = keyframeAt(keyframes, atUs);
  const next = keyframes.filter((keyframe) => keyframe !== existing);
  next.push({ t: existing ? existing.t : atUs, value, easing: existing?.easing ?? 'easeInOut' });
  return next.sort((a, b) => a.t - b.t);
}

export function TransformSheet({
  clipNumber,
  durationUs,
  atUs,
  keyframes,
  onSeekWithin,
  onChange,
  onCommit,
  onClose,
}: TransformProps) {
  const current = useMemo(() => valueAt(keyframes, atUs), [keyframes, atUs]);
  const here = useMemo(() => keyframeAt(keyframes, atUs), [keyframes, atUs]);

  const set = useCallback(
    (key: keyof TransformValue, amount: number) => {
      onChange(writeAt(keyframes, atUs, { ...current, [key]: amount }));
    },
    [atUs, current, keyframes, onChange],
  );

  const toggleKeyframe = useCallback(() => {
    if (here) {
      onChange(keyframes.filter((keyframe) => keyframe !== here));
      return;
    }
    onChange(writeAt(keyframes, atUs, current));
  }, [atUs, current, here, keyframes, onChange]);

  const position = durationUs > 0 ? Math.max(0, Math.min(1, atUs / durationUs)) : 0;

  return (
    <div className="sheet transform" role="dialog" aria-label="Transform">
      <div className="sheet-head">
        <button className="close" onClick={onClose} aria-label="Close">
          ✕
        </button>
        <span className="sheet-count">
          Transform{clipNumber === null ? '' : ` · clip ${clipNumber}`}
          {keyframes.length > 0 && ` · ${keyframes.length} key${keyframes.length === 1 ? '' : 's'}`}
        </span>
        <button
          className={here ? 'primary small auto on' : 'primary small auto'}
          onClick={toggleKeyframe}
          aria-pressed={Boolean(here)}
        >
          {here ? '◆ Remove key' : '◇ Add key'}
        </button>
      </div>

      {/*
        The clip, with its keyframes on it. Dragging this moves the app's playhead, so the
        preview above follows — which is the whole reason the sheet can be this short.
      */}
      <div className="keyline">
        <input
          type="range"
          min={0}
          max={1000}
          step={1}
          value={Math.round(position * 1000)}
          onChange={(event) => onSeekWithin(Math.round((Number(event.target.value) / 1000) * durationUs))}
          aria-label="Position within the clip"
        />
        <div className="keys" aria-hidden="true">
          {keyframes.map((keyframe) => (
            <span
              key={keyframe.t}
              className={keyframe === here ? 'key on' : 'key'}
              style={{ left: `${durationUs > 0 ? (keyframe.t / durationUs) * 100 : 0}%` }}
            />
          ))}
        </div>
        <span className="keyline-clock">
          {formatTimecode(atUs, undefined, { compact: true })} /{' '}
          {formatTimecode(durationUs, undefined, { compact: true })}
        </span>
      </div>

      <div className="sliders">
        {CONTROLS.map((control) => (
          <label key={control.key} className="slider">
            <span className="slider-name">
              {control.label}
              <em>
                {Math.round(current[control.key] * control.scale)}
                {control.suffix}
              </em>
            </span>
            <input
              type="range"
              min={control.min}
              max={control.max}
              step={control.step}
              value={Math.round(current[control.key] * control.scale)}
              onChange={(event) => set(control.key, Number(event.target.value) / control.scale)}
              aria-label={control.label}
            />
          </label>
        ))}
      </div>

      <p className="meta">
        {keyframes.length === 0
          ? 'Adjust anything to frame the whole clip. To build a move instead, add a key here, scrub forward, and adjust again — the second change becomes its own key.'
          : keyframes.length === 1
            ? 'One key: the framing holds for the whole clip. Scrub forward and adjust to make it move.'
            : `${keyframes.length} keys. The framing travels between them across the clip.`}
      </p>

      <div className="sheet-actions">
        <button onClick={() => onChange([])} disabled={keyframes.length === 0}>
          Clear
        </button>
        <button className="primary" onClick={() => onCommit(keyframes.length > 0 ? keyframes : null)}>
          Done
        </button>
      </div>
    </div>
  );
}
