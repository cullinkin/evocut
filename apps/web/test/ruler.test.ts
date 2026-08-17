import { describe, expect, it } from 'vitest';
import { FPS_29_97, FPS_30, FPS_60, type Rational } from '@evocut/edl';
import { ladder, planRuler } from '../src/ruler.ts';

/**
 * The ruler, at every zoom it has.
 *
 * These are the marks a fine cut is aimed at, so what they *say* has to be exactly right —
 * a mark reading `15f` that is not the fifteenth frame is worse than no mark at all. The
 * numbers here are chosen to be the ones actually seen on a phone: `PHONE_PX` is the CSS
 * width of the timeline on an iPhone, and the zooms are quoted as "a second across the
 * screen", "two thirds", "a third", because that is how the ruler is experienced.
 */

/** Usable width of the timeline on the phone this is being built for. */
const PHONE_PX = 393;
/** Pixels per second at which `seconds` of footage fills that screen. */
const fill = (seconds: number) => PHONE_PX / seconds;

const A_MINUTE = 60_000_000;

function labels(pxPerSecond: number, frameRate: Rational = FPS_30, toUs = 2_000_000): string[] {
  const plan = planRuler({ fromUs: 0, toUs, totalUs: A_MINUTE, pxPerSecond, frameRate });
  return plan.ticks.filter((tick) => tick.label !== null).map((tick) => tick.label!);
}

describe('below a second, the ruler counts frames', () => {
  it('puts one mark in the middle of the second when a second fills the screen', () => {
    // The reported bug, exactly: at this zoom the old ruler read "0:00" and "0:01" and had
    // nothing to say about the thirty frames between them.
    expect(labels(fill(1))).toEqual(['0:00', '15f', '0:01', '15f', '0:02']);
  });

  it('breaks the second into thirds, then sixths, as you keep going', () => {
    // The rungs you land on tapping zoom-in from "a second on screen": halves, thirds,
    // sixths. Quoted at the zooms a phone actually reaches, not at round numbers.
    expect(labels(fill(2 / 3))).toEqual(['0:00', '10f', '20f', '0:01', '10f', '20f', '0:02']);
    expect(labels(fill(0.39), FPS_30, 1_000_000)).toEqual(['0:00', '5f', '10f', '15f', '20f', '25f', '0:01']);
    expect(labels(fill(1 / 3), FPS_30, 1_000_000)).toEqual(['0:00', '5f', '10f', '15f', '20f', '25f', '0:01']);
  });

  it('counts in the frame rate the footage was actually shot at', () => {
    // The reason the container is parsed at all. At 60fps the middle of the second is the
    // thirtieth frame, and a ruler that said `15f` there would be off by half a second's
    // worth of frames on every mark.
    expect(labels(fill(1), FPS_60)).toEqual(['0:00', '30f', '0:01', '30f', '0:02']);
    expect(labels(fill(1 / 3), FPS_60, 1_000_000)).toEqual(['0:00', '10f', '20f', '30f', '40f', '50f', '0:01']);
  });

  it('keeps the timecode on the second boundaries', () => {
    const marks = labels(fill(1 / 3), FPS_30, 1_100_000);
    expect(marks[0]).toBe('0:00');
    expect(marks.at(-1)).toBe('0:01');
  });
});

describe('the marks land on real frames', () => {
  it('puts an unlabelled mark on every frame', () => {
    const plan = planRuler({
      fromUs: 0,
      toUs: 1_000_000,
      totalUs: A_MINUTE,
      pxPerSecond: fill(1 / 3),
      frameRate: FPS_30,
    });
    expect(plan.frameGrid).toBe(true);
    // Thirty frames in a second, plus the one that starts the next.
    expect(plan.ticks).toHaveLength(31);
    expect(plan.ticks.map((tick) => tick.frame)).toEqual([...Array(31).keys()]);
    for (const tick of plan.ticks) {
      expect(tick.us).toBe(Math.round((tick.frame * 1_000_000) / 30));
    }
  });

  it('shows the grid before it shows the numbers', () => {
    /*
      Deliberate, and the reason the two spacings differ. A frame mark is legible long
      before a frame *number* has room to sit beside it, and the marks are the part you
      measure with — so at a middling zoom the ruler still reads in seconds while the frame
      grid is already under it.
    */
    const middling = planRuler({
      fromUs: 0,
      toUs: 1_000_000,
      totalUs: A_MINUTE,
      pxPerSecond: 285,
      frameRate: FPS_30,
    });
    expect(middling.frameGrid).toBe(true);
    expect(middling.stepFrames).toBe(30);
    expect(middling.ticks.filter((tick) => tick.label !== null).map((t) => t.label)).toEqual(['0:00', '0:01']);
  });

  it('draws no grid at all when the frames would touch', () => {
    const wide = planRuler({
      fromUs: 0,
      toUs: 10_000_000,
      totalUs: A_MINUTE,
      pxPerSecond: 40,
      frameRate: FPS_30,
    });
    expect(wide.frameGrid).toBe(false);
    expect(wide.ticks.every((tick) => tick.label !== null)).toBe(true);
  });

  it('uses the exact rate for positions and non-drop counting for labels', () => {
    const plan = planRuler({
      fromUs: 0,
      toUs: 2_100_000,
      totalUs: A_MINUTE,
      pxPerSecond: fill(1),
      frameRate: FPS_29_97,
    });
    const labelled = plan.ticks.filter((tick) => tick.label !== null);
    // Thirty frames to a "second", the way non-drop timecode counts — but the sixtieth
    // frame is at 2.002s, not 2.000s, because that is where the frame actually is. Over a
    // two-minute take the difference is a tenth of a second, which is three frames.
    expect(labelled.map((tick) => tick.label)).toEqual(['0:00', '15f', '0:01', '15f', '0:02']);
    expect(labelled.at(-1)!.frame).toBe(60);
    expect(labelled.at(-1)!.us).toBe(2_002_000);
  });
});

describe('above a second, nothing changed', () => {
  it('still counts in round numbers of seconds when the whole edit is on screen', () => {
    // A 73-second assembly fitted to the phone, which is where the timeline opens.
    expect(labels(fill(73), FPS_30, A_MINUTE)).toEqual(['0:00', '0:15', '0:30', '0:45', '1:00']);
  });

  it('coarsens all the way out', () => {
    const plan = planRuler({
      fromUs: 0,
      toUs: 3_600_000_000,
      totalUs: 3_600_000_000,
      pxPerSecond: 4,
      frameRate: FPS_30,
    });
    expect(plan.stepFrames).toBe(30 * 30);
    expect(plan.ticks[1]!.label).toBe('0:30');
  });
});

describe('the window', () => {
  it('builds only what was asked for', () => {
    const plan = planRuler({
      fromUs: 20_000_000,
      toUs: 21_000_000,
      totalUs: A_MINUTE,
      pxPerSecond: fill(1 / 3),
      frameRate: FPS_30,
    });
    expect(plan.ticks.length).toBeLessThan(40);
    expect(plan.ticks.at(-1)!.us).toBeLessThanOrEqual(21_000_000);
    // Aligned to the step rather than to the window, so the labels do not shuffle by a
    // frame or two every time the window moves — which at this zoom would be visible.
    expect(plan.ticks[0]!.frame % 1).toBe(0);
    expect(plan.ticks[0]!.us).toBeGreaterThanOrEqual(19_900_000);
  });

  it('stops at the end of the edit', () => {
    const plan = planRuler({
      fromUs: 0,
      toUs: 30_000_000,
      totalUs: 5_000_000,
      pxPerSecond: 40,
      frameRate: FPS_30,
    });
    expect(plan.ticks.at(-1)!.us).toBeLessThanOrEqual(5_000_000);
  });

  it('has nothing to draw past the end', () => {
    const plan = planRuler({
      fromUs: 10_000_000,
      toUs: 12_000_000,
      totalUs: 5_000_000,
      pxPerSecond: 40,
      frameRate: FPS_30,
    });
    expect(plan.ticks).toEqual([]);
  });
});

describe('the ladder', () => {
  it('divides the second evenly, so a mark is always a whole fraction of one', () => {
    // 8f would be a perfectly reasonable-looking step and a bad one: 8, 16, 24, then 32,
    // which is in the *next* second. Every rung below a second divides it.
    expect(ladder(30).filter((step) => step < 30)).toEqual([1, 2, 3, 5, 6, 10, 15]);
    expect(ladder(60).filter((step) => step < 60)).toEqual([1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30]);
    expect(ladder(24).filter((step) => step < 24)).toEqual([1, 2, 3, 4, 6, 8, 12]);
  });

  it('coarsens in round seconds above one', () => {
    expect(ladder(30).filter((step) => step >= 30).slice(0, 5)).toEqual([30, 60, 150, 300, 450]);
  });

  it('is ordered, because the ruler takes the first rung that fits', () => {
    for (const fps of [24, 25, 30, 50, 60]) {
      const rungs = ladder(fps);
      expect(rungs).toEqual([...rungs].sort((a, b) => a - b));
    }
  });
});
