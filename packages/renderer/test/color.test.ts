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

  it('settles the white balance before saturation, not after', () => {
    const filter = filterFor(grade({ warmth: 0.5, saturation: 0.5 }));
    expect(filter.indexOf('sepia')).toBeLessThan(filter.indexOf('saturate'));
  });
});

/**
 * What the filter does to actual colours.
 *
 * The tests above assert on the *string*, which is how a catastrophe shipped: cooling was
 * `sepia(k) hue-rotate(180deg)`, every string assertion passed, and the picture came back
 * with skin at `#86b8da` and every yellow turned blue. A string cannot tell you that.
 *
 * So this half runs the filter chain as the matrices the spec defines it as, and asks the
 * only question that matters: did the picture change the way the control's name promises,
 * and did every colour that was not being aimed at stay the colour it was?
 */
describe('what the filter does to real colours', () => {
  /** How far the neutral grey moved from red toward blue, out of 255. Negative is cooler. */
  const cast = (value: ColorValue): number => {
    const [r, , b] = run(filterFor(value), [0.5, 0.5, 0.5]);
    return Math.round((r - b) * 255);
  };

  /** The green/magenta axis of the same grey. Positive is toward magenta. */
  const greenMagenta = (value: ColorValue): number => {
    const [r, g, b] = run(filterFor(value), [0.5, 0.5, 0.5]);
    return Math.round(((r + b) / 2 - g) * 255);
  };

  /** The worst hue shift over a spread of real subject colours, in degrees. */
  const drift = (value: ColorValue): number => {
    const filter = filterFor(value);
    return Math.max(
      ...Object.values(SUBJECTS).map((colour) => {
        const before = hueOf(colour);
        const after = hueOf(run(filter, colour));
        if (before === null || after === null) return 0;
        return Math.abs(((after - before + 540) % 360) - 180);
      }),
    );
  };

  it('warms and cools symmetrically', () => {
    expect(cast(grade({ warmth: 1 }))).toBeGreaterThan(12);
    expect(cast(grade({ warmth: -1 }))).toBeLessThan(-12);
    expect(cast(grade({ warmth: 1 }))).toBe(-cast(grade({ warmth: -1 })));
  });

  it('tints toward magenta and toward green', () => {
    expect(greenMagenta(grade({ tint: 1 }))).toBeGreaterThan(4);
    expect(greenMagenta(grade({ tint: -1 }))).toBeLessThan(-4);
  });

  /**
   * The regression, stated as the thing that was actually wrong.
   *
   * A white-balance control moves the *neutral*. It must not repaint the subject: cooling a
   * shot does not turn a yellow booster pack blue, and a check that allows 180° of drift is
   * a check that would have watched this happen.
   */
  it('never repaints the subject — no control may swing a hue', () => {
    for (const amount of [-1, -0.5, 0.5, 1]) {
      expect(drift(grade({ warmth: amount }))).toBeLessThan(20);
      expect(drift(grade({ tint: amount }))).toBeLessThan(20);
      expect(drift(grade({ warmth: amount, tint: amount }))).toBeLessThan(30);
    }
  });

  it('specifically: cooling leaves yellow yellow and skin skin', () => {
    const cooled = filterFor(grade({ warmth: -1 }));
    // Yellow lives near 50°, and 180° away is the blue that was reported.
    expect(hueOf(run(cooled, SUBJECTS.yellow))!).toBeGreaterThan(30);
    expect(hueOf(run(cooled, SUBJECTS.yellow))!).toBeLessThan(70);
    expect(hueOf(run(cooled, SUBJECTS.skin))!).toBeGreaterThan(5);
    expect(hueOf(run(cooled, SUBJECTS.skin))!).toBeLessThan(50);
  });

  it('brightens and darkens the way exposure says', () => {
    const luma = (value: ColorValue) => run(filterFor(value), [0.5, 0.5, 0.5])[0];
    expect(luma(grade({ exposure: 0.5 }))).toBeGreaterThan(0.5);
    expect(luma(grade({ exposure: -0.5 }))).toBeLessThan(0.5);
  });
});

/** Colours from the footage this was reported on: skin, a booster pack, a playmat. */
const SUBJECTS = {
  skin: [0.85, 0.65, 0.52],
  yellow: [0.95, 0.82, 0.18],
  blue: [0.35, 0.62, 0.88],
  red: [0.8, 0.15, 0.15],
  green: [0.25, 0.65, 0.3],
} satisfies Record<string, RGB>;

type RGB = [number, number, number];

/**
 * Run a CSS `filter` string over one colour, as the Filter Effects spec defines it.
 *
 * Only the primitives `filterFor` emits, and no more — an incomplete interpreter that
 * throws on anything it does not know is worth more here than a lenient one that silently
 * ignores the function under test.
 */
function run(filter: string, colour: RGB): RGB {
  if (filter === 'none') return colour;
  let out = colour;
  for (const [, name, argument] of filter.matchAll(/([a-z-]+)\(([^)]*)\)/g)) {
    out = primitive(name!, argument!, out);
  }
  return out;
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const SEPIA = [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131];

function primitive(name: string, argument: string, [r, g, b]: RGB): RGB {
  const amount = Number.parseFloat(argument);
  switch (name) {
    case 'brightness':
      return [r * amount, g * amount, b * amount];
    case 'contrast':
      return [r, g, b].map((v) => v * amount + (0.5 - 0.5 * amount)) as RGB;
    case 'invert':
      return [1 - r, 1 - g, 1 - b];
    case 'saturate': {
      const l = 0.213 * r + 0.715 * g + 0.072 * b;
      return [l + (r - l) * amount, l + (g - l) * amount, l + (b - l) * amount];
    }
    case 'sepia':
      return matrix(
        SEPIA.map((v, i) => IDENTITY[i]! * (1 - amount) + v * amount),
        [r, g, b],
      );
    case 'hue-rotate': {
      const t = (amount * Math.PI) / 180;
      const c = Math.cos(t);
      const s = Math.sin(t);
      return matrix(
        [
          0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
          0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283,
          0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
        ],
        [r, g, b],
      );
    }
    default:
      throw new Error(`the colour tests do not know the filter primitive "${name}"`);
  }
}

function matrix(m: number[], [r, g, b]: RGB): RGB {
  return [
    m[0]! * r + m[1]! * g + m[2]! * b,
    m[3]! * r + m[4]! * g + m[5]! * b,
    m[6]! * r + m[7]! * g + m[8]! * b,
  ];
}

/** Hue in degrees, or null for something with no hue to speak of. */
function hueOf([r, g, b]: RGB): number | null {
  const high = Math.max(r, g, b);
  const low = Math.min(r, g, b);
  const range = high - low;
  if (range < 1e-6) return null;
  let hue = high === r ? ((g - b) / range) % 6 : high === g ? (b - r) / range + 2 : (r - g) / range + 4;
  hue *= 60;
  return hue < 0 ? hue + 360 : hue;
}

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
