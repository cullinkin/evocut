import { useCallback, useMemo, useState } from 'react';
import { formatTimecode, sampleTransform, type Easing, type TransformValue } from '@evocut/edl';
import { PanelHistory, PanelTabs, useDraftHistory } from './panel.tsx';
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
  /** One frame of the timeline, which is what a keyframe's position is rounded to. */
  frameUs: number;
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

/**
 * How close two keyframes have to be to count as the same one: the same frame.
 *
 * It used to be a flat 66ms — two frames at 30fps — which was a sliver of the screen at the
 * zoom the timeline had when it was written. The timeline now zooms until a third of a
 * second fills the phone, where 66ms is a *fifth of the screen*: you move along a visibly
 * long way, adjust, and the adjustment silently rewrites the keyframe you just made instead
 * of adding one. Reported exactly that way — "if I try moving along the timeline, zooming in
 * to drop another, it just doesn't".
 *
 * A frame is the honest answer, because a frame is the finest distinction the output can
 * carry. Half of one either side, so it means "this frame" and not "this frame or its
 * neighbour".
 */
export function sameFrame(frameUs: number): number {
  return Math.max(1, frameUs / 2);
}

/** The framing at `atUs`, whether or not a keyframe sits there. */
export function valueAt(keyframes: Keyframe[], atUs: number): TransformValue {
  if (keyframes.length === 0) return { ...IDENTITY };
  return sampleTransform(keyframes, atUs);
}

/** The keyframe at `atUs`, if there is one. */
export function keyframeAt(keyframes: Keyframe[], atUs: number, frameUs: number): Keyframe | null {
  const near = sameFrame(frameUs);
  return keyframes.find((keyframe) => Math.abs(keyframe.t - atUs) < near) ?? null;
}

/**
 * Write a value in at `atUs`, replacing the keyframe there or adding one.
 *
 * The auto-keyframe rule lives here rather than in the component so it can be reasoned
 * about on its own: an empty list gets a single keyframe (a static reframe, no move); a
 * list that already has keyframes gets a new one at this instant, which is what makes
 * "move forward, adjust" build a move instead of rewriting the one that exists.
 */
export function writeAt(
  keyframes: Keyframe[],
  atUs: number,
  value: TransformValue,
  frameUs: number,
): Keyframe[] {
  const existing = keyframeAt(keyframes, atUs, frameUs);
  const next = keyframes.filter((keyframe) => keyframe !== existing);
  next.push({ t: existing ? existing.t : atUs, value, easing: existing?.easing ?? 'easeInOut' });
  return next.sort((a, b) => a.t - b.t);
}

/**
 * The frame boundary a time belongs to.
 *
 * Keyframes land on frames because frames are what gets rendered. A key at an arbitrary
 * microsecond is a key whose value is never sampled exactly — the frame before it and the
 * frame after it both show an interpolation — which is the "they don't drop where I tell
 * them to, they are offset a bit" that started this.
 */
export function snapToFrame(atUs: number, frameUs: number): number {
  if (!Number.isFinite(frameUs) || frameUs <= 0) return Math.round(atUs);
  return Math.round(Math.round(atUs / frameUs) * frameUs);
}

export function TransformPanel({
  clipNumber,
  clipStartUs,
  durationUs,
  frameUs,
  keyframes,
  onChange,
  onCommit,
  onClose,
}: TransformProps) {
  const [tab, setTab] = useState<Tab>('position');
  // Subscribed here rather than passed down, so scrubbing the timeline while the panel is
  // open re-renders the panel and nothing above it.
  const playhead = usePlayhead();
  /*
    Where in the clip we are — on a frame, and honestly.

    `outside` is the case that used to be silently wrong. The panel is opened on one clip
    and the timeline stays live, so the playhead can walk off the end of it; this used to
    clamp, which meant every adjustment made from anywhere else in the edit landed on the
    *last frame of this clip*. The first such write, on a clip with no keys, is a single
    keyframe — a static reframe of the whole shot. "The whole clip seems to be set at that
    zoom then instead of in a new keyframe" is precisely that, and the panel said nothing.

    The editor moves the panel to whatever clip the playhead is over, so this state is brief;
    when it happens anyway the controls stand down rather than write somewhere false.
  */
  const rawUs = playhead - clipStartUs;
  const outside = rawUs < -sameFrame(frameUs) || rawUs > durationUs + sameFrame(frameUs);
  const atUs = snapToFrame(Math.max(0, Math.min(durationUs, rawUs)), frameUs);

  const history = useDraftHistory(keyframes, onChange);

  const current = useMemo(() => valueAt(keyframes, atUs), [keyframes, atUs]);
  const here = useMemo(() => keyframeAt(keyframes, atUs, frameUs), [keyframes, atUs, frameUs]);

  const set = useCallback(
    (key: keyof TransformValue, amount: number) => {
      if (outside) return;
      history.remember(keyframes);
      onChange(writeAt(keyframes, atUs, { ...current, [key]: amount }, frameUs));
    },
    [atUs, current, frameUs, history, keyframes, onChange, outside],
  );

  const toggleKeyframe = useCallback(() => {
    if (outside) return;
    history.remember(keyframes);
    onChange(
      here
        ? keyframes.filter((keyframe) => keyframe !== here)
        : writeAt(keyframes, atUs, current, frameUs),
    );
  }, [atUs, current, frameUs, here, history, keyframes, onChange, outside]);

  const active = TABS.find((entry) => entry.id === tab) ?? TABS[0]!;

  return (
    <section className="panel transform" aria-label="Transform">
      <div className="panel-top">
        <button className="close" onClick={onClose} aria-label="Close">
          ✕
        </button>
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
        <PanelHistory {...history} what="framing" />
        <button
          className="ghost small"
          onClick={() => {
            history.remember(keyframes);
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

      <PanelTabs tabs={TABS.map((entry) => ({ id: entry.id, label: entry.label }))} active={tab} onPick={setTab} />

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

    </section>
  );
}
