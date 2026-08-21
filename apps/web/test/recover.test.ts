import { beforeEach, describe, expect, it } from 'vitest';
import { STALE_AFTER_MS, beginOpen, clearOnExit, finishOpen, noteStage, resetOpen, shouldRecover } from '../src/recover.ts';

/**
 * Noticing that the last open did not finish.
 *
 * Reported from a phone: the editor appears for a moment, the screen goes black, and every
 * reload does it again — the app locking its user out of their own edit, and out of the log
 * that would have said why.
 */
/** Node has no `localStorage`; the rule under test is about what is written to one. */
function fakeStorage() {
  const held = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => held.get(key) ?? null,
      setItem: (key: string, value: string) => void held.set(key, value),
      removeItem: (key: string) => void held.delete(key),
    },
  });
}

describe('recovering from an open that killed the tab', () => {
  beforeEach(() => {
    fakeStorage();
    resetOpen();
  });

  it('is a normal open when the last one finished', () => {
    expect(beginOpen('prj_1')).toBe(null);
    finishOpen();
    expect(beginOpen('prj_1')).toBe(null);
  });

  it('reports the stage the last open died at', () => {
    beginOpen('prj_1', 1_000);
    noteStage('measure', 1_500);
    // No `finishOpen`: the process ended here.
    const failed = beginOpen('prj_1', 2_000);
    expect(failed?.stage).toBe('measure');
  });

  it('only recovers the project that died, not the next one opened', () => {
    beginOpen('prj_1', 1_000);
    expect(beginOpen('prj_2', 2_000)).toBe(null);
  });

  it('ignores a breadcrumb from another sitting', () => {
    /*
      A tab closed normally mid-analysis leaves one behind — the process ended, so nothing
      cleared it — and that is not a crash. Coming back tomorrow and being told the app is
      in recovery would be worse than useless.
    */
    const previous = { projectId: 'prj_1', stage: 'measure', at: 1_000 };
    expect(shouldRecover(previous, 'prj_1', 1_000 + STALE_AFTER_MS - 1)).toBe(true);
    expect(shouldRecover(previous, 'prj_1', 1_000 + STALE_AFTER_MS + 1)).toBe(false);
  });

  it('treats leaving the page on purpose as a finished open', () => {
    /*
      What tells a crash from a reload. `pagehide` fires when a page is navigated away
      from; a process killed for using too much memory fires nothing at all — so a
      breadcrumb that survives is one nobody had the chance to clean up.
    */
    const listeners = new Map<string, () => void>();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        addEventListener: (name: string, fn: () => void) => void listeners.set(name, fn),
        removeEventListener: (name: string) => void listeners.delete(name),
      },
    });

    const stop = clearOnExit();
    beginOpen('prj_1', 1_000);
    listeners.get('pagehide')?.();
    expect(beginOpen('prj_1', 2_000)).toBe(null);

    stop();
    expect(listeners.has('pagehide')).toBe(false);
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('survives storage that refuses to answer', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('denied');
      },
    });
    // A private window is not a reason to fail to open a project.
    expect(() => beginOpen('prj_1')).not.toThrow();
    expect(beginOpen('prj_1')).toBe(null);
  });
});
