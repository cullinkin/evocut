import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_HOLD_MS, QUIET_MS, holdFor, lastInteractionAt, noteInteraction, resetQuiet } from '../src/quiet.ts';

/**
 * When background work is allowed to take the main thread.
 *
 * The measurement this rule exists for, off a screen recording of a real session: while the
 * user was scrubbing, the whole interface — preview and timeline together — updated 26 to
 * 32 times a second on a 60Hz phone, with entire seconds where nothing moved. They froze in
 * lockstep, which rules out anything about drawing either of them: the main thread was gone,
 * extracting filmstrip thumbnails.
 */
describe('holding off while the user is working', () => {
  beforeEach(resetQuiet);

  it('runs immediately when nothing has happened', () => {
    expect(holdFor(0, 10_000, 0)).toBe(0);
  });

  it('waits out the rest of the gap after an interaction', () => {
    const at = 1_000;
    expect(holdFor(at, at + 50, 0)).toBe(QUIET_MS - 50);
    expect(holdFor(at, at + QUIET_MS - 1, 0)).toBe(1);
    expect(holdFor(at, at + QUIET_MS, 0)).toBe(0);
  });

  it('gives up holding rather than never running at all', () => {
    /*
      Playback moves the playhead sixty times a second for as long as it runs, so a rule
      that waits for silence would wait for the user to stop watching their own footage.
      The hold is bounded: sustained interaction slows the pass to one seek every few
      seconds instead of stopping it dead.
    */
    const at = 1_000;
    expect(holdFor(at, at + 10, MAX_HOLD_MS)).toBe(0);
    expect(holdFor(at, at + 10, MAX_HOLD_MS - 100)).toBe(100);
  });

  it('remembers when the last interaction was', () => {
    noteInteraction(4_242);
    expect(lastInteractionAt()).toBe(4_242);
  });
});
