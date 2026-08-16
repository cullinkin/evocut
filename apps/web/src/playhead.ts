import { useSyncExternalStore } from 'react';

/**
 * Where the playhead is, outside React.
 *
 * ## Why this exists
 *
 * A scroll gesture moves the playhead sixty times a second, and playback does the same.
 * While the playhead lived in the session's `useState`, every one of those was a render of
 * the entire editor — header, preview, timeline, toolbar, footer — because everything hangs
 * off the component that owned it. Memoising the clip blocks stopped the *lane* being
 * rebuilt, which was the worst of it, but the reconcile itself still ran end to end on
 * every frame, and on a phone that is most of a frame budget spent deciding nothing changed.
 *
 * The playhead is not really application state. It is a cursor: three or four things need
 * to know it, they need to know it immediately, and nothing else in the tree cares. So it
 * lives here, and the handful of components that need it subscribe individually — the
 * preview, the timeline, the two clocks. A scroll now re-renders those and nothing else.
 *
 * ## And a coalesced copy for everything else
 *
 * `session.playhead` still exists, because plenty of things legitimately want the position
 * at render time — which clip to open the tools on, where a cut will land. It is updated
 * from here on a timer instead of on every change, so it is at most a fraction of a second
 * stale and costs a render four times a second rather than sixty.
 */
let current = 0;
const listeners = new Set<() => void>();

export function getPlayhead(): number {
  return current;
}

export function setPlayhead(us: number): void {
  const next = Math.max(0, Math.round(us));
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

export function subscribePlayhead(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Subscribe to the playhead.
 *
 * `useSyncExternalStore` rather than an effect and a `useState`, because it is the one hook
 * that guarantees a component reading an outside value cannot paint a frame with a stale
 * one — which for a playhead means the preview and the clock disagreeing by a frame during
 * a fast scroll.
 */
export function usePlayhead(): number {
  return useSyncExternalStore(subscribePlayhead, getPlayhead, getPlayhead);
}

/** Reset on close, so a new project does not open where the last one was left. */
export function resetPlayhead(): void {
  current = 0;
  for (const listener of listeners) listener();
}
