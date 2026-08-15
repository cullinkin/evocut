import { describe, expect, it } from 'vitest';
import { NEUTRAL_COLOR, type ColorValue } from '@evocut/edl';
import { autoColor, filterFor, measureFrame, normalizeColor } from '../src/color.js';

/**
 * A grade only exists twice — as a CSS `filter` on the preview element and as `ctx.filter`
 * on the export canvas — and both come from `filterFor`. So what is worth asserting is not
 * the exact string but the properties that make the two agree and make the sliders behave:
 * that neutral is genuinely nothing, that each control moves the primitive it claims to,
 * and that the order the functions come out in is the order that makes them mean what they
 * say.
 */
function grade(over: Partial<ColorValue> = {}): ColorValue {
  return { ...NEUTRAL_COLOR, ...over };
}

/** An RGBA buffer of one repeated colour, which is enough for every statistic here. */
function flat(r: number, g: number, b: number, pixels = 64): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels * 4);
  for (let at = 0; at < pixels; at += 1) {
    out[at * 4] = r;
    out[at * 4 + 1] = g;
    out[at * 4 + 2] = b;
    out[at * 4 + 3] = 255;
  }
  return out;
}

/** Half the pixels at `low`, half at `high` — a frame with a known black and white point. */
function twoTone(low: number, high: number, pixels = 64): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels * 4);
  for (let at = 0; at < pixels; at += 1) {
    const value = at < pixels / 2 ? low : high;
    out[at * 4] = value;
    out[at * 4 + 1] = value;
    out[at * 4 + 2] = value;
    out[at * 4 + 3] = 255;
  }
  return out;
}

/** An even ramp from `low` to `high` — what a well-exposed frame looks like statistically. */
function ramp(low: number, high: number, pixels = 256): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels * 4);
  for (let at = 0; at < pixels; at += 1) {
    const value = Math.round(low + ((high - low) * at) / (pixels - 1));
    out[at * 4] = value;
    out[at * 4 + 1] = value;
    out[at * 4 + 2] = value;
    out[at * 4 + 3] = 255;
  }
  return out;
}

describe('filterFor', () => {
  it('is nothing at all when nothing was adjusted', () => {
    expect(filterFor(grade())).toBe('none');
    expect(filterFor(null)).toBe('none');
    expect(filterFor(undefined)).toBe('none');
  });

  it('moves the primitive each control is named after', () => {
    expect(filterFor(grade({ exposure: 0.5 }))).toMatch(/brightness\(1\.3\)/);
    expect(filterFor(grade({ contrast: 0.5 }))).toMatch(/contrast\(1\.25\)/);
    expect(filterFor(grade({ saturation: 0.5 }))).toMatch(/saturate\(1\.4\)/);
  });

  it('is symmetric about zero, so a slider dragged out and back lands where it started', () => {
    const up = filterFor(grade({ exposure: 0.4 }));
    const down = filterFor(grade({ exposure: -0.4 }));
    const brightness = (filter: string) => Number(/brightness\(([\d.]+)\)/.exec(filter)![1]);
    expect(brightness(up) - 1).toBeCloseTo(1 - brightness(down), 6);
  });

  it('brightens without flattening: brilliance lifts and gives contrast back', () => {
    const filter = filterFor(grade({ brilliance: 0.6 }));
    expect(Number(/brightness\(([\d.]+)\)/.exec(filter)![1])).toBeGreaterThan(1);
    // The tone-curve half of it — a lift with no contrast given back is a wash.
    expect(Number(/contrast\(([\d.]+)\)/.exec(filter)![1])).toBeLessThan(1);
  });

  it('deepens rather than lifts when brilliance goes the other way', () => {
    const filter = filterFor(grade({ brilliance: -0.6 }));
    expect(Number(/brightness\(([\d.]+)\)/.exec(filter)![1])).toBeLessThan(1);
    expect(Number(/contrast\(([\d.]+)\)/.exec(filter)![1])).toBeGreaterThan(1);
  });

  it('cools by spinning the warm push half a turn, since sepia only goes one way', () => {
    expect(filterFor(grade({ warmth: 0.5 }))).not.toMatch(/hue-rotate\(180deg\)/);
    expect(filterFor(grade({ warmth: -0.5 }))).toMatch(/sepia\([\d.]+\) hue-rotate\(180deg\)/);
  });

  it('settles the white balance before saturation, not after', () => {
    const filter = filterFor(grade({ warmth: 0.5, saturation: 0.5 }));
    expect(filter.indexOf('sepia')).toBeLessThan(filter.indexOf('saturate'));
  });
});

describe('normalizeColor', () => {
  it('fills in what is missing and clamps what is out of range', () => {
    expect(normalizeColor({ exposure: 4, contrast: -9 })).toEqual(
      grade({ exposure: 1, contrast: -1 }),
    );
    expect(normalizeColor(null)).toEqual(grade());
    expect(normalizeColor({ exposure: Number.NaN })).toEqual(grade());
  });
});

describe('measureFrame', () => {
  it('reads the black and white points off a two-tone frame', () => {
    const stats = measureFrame(twoTone(51, 204));
    expect(stats.black).toBeCloseTo(0.2, 1);
    expect(stats.white).toBeCloseTo(0.8, 1);
  });

  it('weights the channels the way an eye does', () => {
    // Full green is far brighter to look at than full blue, and a plain average would
    // call them the same and try to correct one of them.
    expect(measureFrame(flat(0, 255, 0)).mid).toBeGreaterThan(measureFrame(flat(0, 0, 255)).mid);
  });

  it('calls grey unsaturated and a primary saturated', () => {
    expect(measureFrame(flat(128, 128, 128)).saturation).toBe(0);
    expect(measureFrame(flat(200, 20, 20)).saturation).toBeGreaterThan(0.8);
  });

  it('ignores transparent padding rather than calling it black footage', () => {
    const framed = new Uint8ClampedArray(flat(200, 200, 200, 8));
    for (let at = 0; at < 4; at += 1) framed[at * 4 + 3] = 0; // letterbox
    expect(measureFrame(framed).mid).toBeCloseTo(measureFrame(flat(200, 200, 200)).mid, 2);
  });

  it('answers rather than dividing by zero on an empty frame', () => {
    expect(measureFrame(new Uint8ClampedArray(0)).mid).toBe(0.5);
  });
});

describe('autoColor', () => {
  it('does almost nothing to a frame that is already fine', () => {
    // A full-range ramp: black point near black, white point near white, midtone in the
    // middle. There is nothing here for an auto-adjust to fix, and it should say so.
    const auto = autoColor(measureFrame(ramp(5, 250)));
    expect(Math.abs(auto.contrast)).toBeLessThan(0.15);
    expect(Math.abs(auto.exposure)).toBeLessThan(0.15);
  });

  it('adds contrast to a flat shot', () => {
    // Nothing darker than 40% or brighter than 60%: the classic indoor phone clip.
    expect(autoColor(measureFrame(twoTone(102, 153))).contrast).toBeGreaterThan(0.25);
  });

  it('opens the shadows when the blacks are crushed and closes them when they are hazy', () => {
    expect(autoColor(measureFrame(twoTone(0, 200))).brilliance).toBeGreaterThan(0);
    expect(autoColor(measureFrame(twoTone(90, 220))).brilliance).toBeLessThan(0);
  });

  it('lifts a drab frame and leaves a colourful one alone', () => {
    expect(autoColor(measureFrame(flat(120, 122, 118))).saturation).toBeGreaterThan(0.1);
    expect(autoColor(measureFrame(flat(220, 40, 30))).saturation).toBe(0);
  });

  it('cools a warm cast and warms a cool one', () => {
    expect(autoColor(measureFrame(flat(200, 150, 110))).warmth).toBeLessThan(0);
    expect(autoColor(measureFrame(flat(110, 150, 200))).warmth).toBeGreaterThan(0);
  });

  it('never proposes anything a slider could not reach', () => {
    for (const frame of [flat(0, 0, 0), flat(255, 255, 255), flat(255, 0, 255), twoTone(0, 255)]) {
      const auto = autoColor(measureFrame(frame));
      for (const amount of Object.values(auto)) {
        expect(amount).toBeGreaterThanOrEqual(-1);
        expect(amount).toBeLessThanOrEqual(1);
      }
    }
  });
});
