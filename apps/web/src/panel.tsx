import { useCallback, useRef, useState } from 'react';

/**
 * The parts every clip-tool panel shares.
 *
 * A panel is not a sheet. It takes the toolbar's place under the timeline rather than
 * covering it, so the preview keeps its height and the timeline stays live while you work.
 * That constraint is what shapes everything here: one control group on screen at a time,
 * a tab strip to reach the rest, and a top row for the things that are always available.
 */

/**
 * Undo and redo over a panel's uncommitted draft.
 *
 * Local on purpose. Nothing reaches the EDL until Done, so the app-wide undo cannot help —
 * it would have to take back the whole session with the panel. And these tools are used by
 * nudging: "that went too far" is the most common thing you want to say to a slider, and it
 * should cost one tap.
 *
 * `remember` is called with the value *before* a change. Callers do that rather than the
 * hook watching the value, because a slider drag emits a value per pixel of travel and a
 * hook that recorded each of them would give you a hundred taps of undo to get back one
 * decision.
 */
export function useDraftHistory<T>(value: T, onChange: (next: T) => void) {
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const [depth, setDepth] = useState({ back: 0, forward: 0 });

  const sync = useCallback(() => {
    setDepth({ back: past.current.length, forward: future.current.length });
  }, []);

  const remember = useCallback(
    (before: T) => {
      // Bounded, because a long session with a panel open should not grow without limit,
      // and nobody reaches for the fortieth undo.
      past.current = [...past.current.slice(-40), before];
      future.current = [];
      sync();
    },
    [sync],
  );

  const undo = useCallback(() => {
    const previous = past.current.pop();
    if (previous === undefined) return;
    future.current = [...future.current, value];
    sync();
    onChange(previous);
  }, [onChange, sync, value]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (next === undefined) return;
    past.current = [...past.current, value];
    sync();
    onChange(next);
  }, [onChange, sync, value]);

  return { remember, undo, redo, canUndo: depth.back > 0, canRedo: depth.forward > 0 };
}

/**
 * The tab strip.
 *
 * Scrolls when there are more tabs than fit, which is what lets six colour controls occupy
 * the same height as one — the alternative is six sliders stacked, and six sliders is a
 * sheet, and a sheet covers the timeline.
 */
export function PanelTabs<T extends string>({
  tabs,
  active,
  onPick,
}: {
  tabs: ReadonlyArray<{ id: T; label: string }>;
  active: T;
  // A setter, usually. Typed as one so `setTab` can be passed straight in without the
  // caller wrapping it in an arrow that React would rebuild every render.
  onPick: (id: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={tab.id === active}
          className={tab.id === active ? 'tab on' : 'tab'}
          onClick={() => onPick(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** Undo and redo, identical in every panel. */
export function PanelHistory({
  undo,
  redo,
  canUndo,
  canRedo,
  what,
}: {
  undo(): void;
  redo(): void;
  canUndo: boolean;
  canRedo: boolean;
  /** Named in the labels, so a screen reader says which undo this is. */
  what: string;
}) {
  return (
    <>
      <button className="icon" onClick={undo} disabled={!canUndo} aria-label={`Undo ${what}`}>
        ⤺
      </button>
      <button className="icon" onClick={redo} disabled={!canRedo} aria-label={`Redo ${what}`}>
        ⤻
      </button>
    </>
  );
}
