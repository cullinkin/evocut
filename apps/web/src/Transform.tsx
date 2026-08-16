import { useCallback, useMemo, useRef, useState } from 'react';
import { formatTimecode, sampleTransform, type Easing, type TransformValue } from '@evocut/edl';
import { usePlayhead } from './playhead.ts';

/**
 * Framing over time: zoom, pan and rotation, keyframed.
 *
 * ## A panel, not a sheet
 *
 * The first version was a bottom sheet with its own scrubber inside it, because a sheet
 * covers the timeline. That was solving the wrong problem: what you want while framing a
 * shot is the *whole* editor — the preview at full size, the timeline where it always is,
 * and the controls taking as little room as they can get away with. So this is not an
 * overlay at all. It replaces the toolbar and sits under the timeline, which stays live:
 * you scrub with the timeline you already know, and keys drop where the playhead is.
 *
 * That is also what makes it short enough to be usable. Four controls split across three
 * tabs means at most two sliders on screen, which leaves the preview its full height.
 *
 * ## The flow
 *
 * Drop a key, scrub forward, adjust — and the adjustment lands as a *second* key rather
 * than editing the first. Once a clip has any keys at all, changing a slider at a time that
 * has none creates one there, carrying the values just set and leaving everything before it
 * alone. That is how every editor does it and it is the only version that lets you build a
 * move without thinking about the data structure.
 *
 * ## Undo and redo are local
 *
 * They walk this panel's own draft, not the project's history. A move is built by nudging,
 * and "that went too far" wants to cost one tap — where the app-wide undo would have to
 * take back the whole session with the panel, because nothing is committed until Done.
 */
export interface Keyframe {
  t: number;
  value: TransformValue;
  easing: Easing;
}

export interface TransformProps {
  clipNumber: number | null;
  /** Where the clip starts on the output timeline, so the playhead can be made relative. */
  clipStartUs: number;
  /** Output length of the clip. */
  durationUs: number;
  keyframes: Keyframe[];
  onChange(keyframes: Keyframe[]): void;
  onCommit(keyframes: Keyframe[] | null): void;
  onClose(): void;
}

type Tab = 'position' | 'zoom' | 'rotate';

interface Control {
  key: keyof TransformValue;
  label: string;
  min: number;
  max: number;
  /** Slider units per unit of value, so a fraction shows as a percentage. */
  scale: number;
  suffix: string;
}

const TABS: Array<{ id: Tab; label: string; controls: Control[] }> = [
  {
    id: 'position',
    label: 'Position',
    controls: [
      { key: 'x', label: 'X axis', min: -100, max: 100, scale: 100, suffix: '' },
      { key: 'y', label: 'Y axis', min: -100, max: 100, scale: 100, suffix: '' },
    ],
  },
  {
    id: 'zoom',
    label: 'Zoom',
    controls: [{ key: 'scale', label: 'Zoom', min: 25, max: 400, scale: 100, suffix: '%' }],
  },
  {
    id: 'rotate',
    label: 'Rotate',
    controls: [{ key: 'rotation', label: 'Rotate', min: -180, max: 180, scale: 1, suffix: '°' }],
  },
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

export function TransformPanel({
  clipNumber,
  clipStartUs,
  durationUs,
  keyframes,
  onChange,
  onCommit,
  onClose,
}: TransformProps) {
  const [tab, setTab] = useState<Tab>('position');
  // Subscribed here rather than passed down, so scrubbing the timeline while the panel is
  // open re-renders the panel and nothing above it.
  const playhead = usePlayhead();
  const atUs = Math.max(0, Math.min(durationUs, playhead - clipStartUs));

  /*
    Local undo, over the draft.

    Two stacks and a flag, because every `onChange` from a slider would otherwise push a
    history entry per pixel of travel. `stepping` marks the changes this panel made on
    purpose — an undo, a redo — so they replace the present rather than being recorded as
    new states to undo back to.
  */
  const past = useRef<Keyframe[][]>([]);
  const future = useRef<Keyframe[][]>([]);
  const [depth, setDepth] = useState({ back: 0, forward: 0 });
  const remember = useCallback(
    (before: Keyframe[]) => {
      past.current = [...past.current.slice(-40), before];
      future.current = [];
      setDepth({ back: past.current.length, forward: 0 });
    },
    [],
  );

  const current = useMemo(() => valueAt(keyframes, atUs), [keyframes, atUs]);
  const here = useMemo(() => keyframeAt(keyframes, atUs), [keyframes, atUs]);

  const set = useCallback(
    (key: keyof TransformValue, amount: number) => {
      remember(keyframes);
      onChange(writeAt(keyframes, atUs, { ...current, [key]: amount }));
    },
    [atUs, current, keyframes, onChange, remember],
  );

  const toggleKeyframe = useCallback(() => {
    remember(keyframes);
    onChange(
      here ? keyframes.filter((keyframe) => keyframe !== here) : writeAt(keyframes, atUs, current),
    );
  }, [atUs, current, here, keyframes, onChange, remember]);

  const undo = useCallback(() => {
    const previous = past.current.pop();
    if (!previous) return;
    future.current = [...future.current, keyframes];
    setDepth({ back: past.current.length, forward: future.current.length });
    onChange(previous);
  }, [keyframes, onChange]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current = [...past.current, keyframes];
    setDepth({ back: past.current.length, forward: future.current.length });
    onChange(next);
  }, [keyframes, onChange]);

  const active = TABS.find((entry) => entry.id === tab) ?? TABS[0]!;

  return (
    <section className="panel transform" aria-label="Transform">
      <div className="panel-top">
        <button
          className={here ? 'key-toggle on' : 'key-toggle'}
          onClick={toggleKeyframe}
          aria-pressed={Boolean(here)}
          aria-label={here ? 'Remove keyframe' : 'Add keyframe'}
        >
          <span aria-hidden="true">◆</span>
        </button>
        <span className="panel-title">
          {clipNumber === null ? 'Transform' : `Clip ${clipNumber}`}
          <em>
            {formatTimecode(atUs, undefined, { compact: true })}
            {keyframes.length > 0 && ` · ${keyframes.length} key${keyframes.length === 1 ? '' : 's'}`}
          </em>
        </span>
        <button className="icon" onClick={undo} disabled={depth.back === 0} aria-label="Undo framing">
          ⤺
        </button>
        <button className="icon" onClick={redo} disabled={depth.forward === 0} aria-label="Redo framing">
          ⤻
        </button>
        <button className="close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="tabs" role="tablist">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            role="tab"
            aria-selected={entry.id === tab}
            className={entry.id === tab ? 'tab on' : 'tab'}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="sliders">
        {active.controls.map((control) => (
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
              step={1}
              value={Math.round(current[control.key] * control.scale)}
              onChange={(event) => set(control.key, Number(event.target.value) / control.scale)}
              aria-label={control.label}
            />
          </label>
        ))}
      </div>

      <div className="panel-actions">
        <button
          className="ghost"
          onClick={() => {
            remember(keyframes);
            onChange([]);
          }}
          disabled={keyframes.length === 0}
        >
          Reset
        </button>
        <button
          className="primary confirm"
          onClick={() => onCommit(keyframes.length > 0 ? keyframes : null)}
          aria-label="Done"
        >
          ✓
        </button>
      </div>
    </section>
  );
}
