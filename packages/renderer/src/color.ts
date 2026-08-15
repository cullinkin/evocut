import { NEUTRAL_COLOR, isNeutralColor, type ColorValue } from '@evocut/edl';

/**
 * A grade, turned into an actual image operation — in exactly one place.
 *
 * The preview is a `<video>` element with a CSS `filter`; the export is a 2D canvas with
 * `ctx.filter`. Those take the *same* syntax, which is the entire reason the grade is
 * expressed this way rather than as a pixel loop or a colour matrix. One function produces
 * one string, both surfaces set it, and "the export came out a different colour from the
 * preview" is not a bug that can exist. That is the same bargain `placeLayer` makes for
 * framing, and it is worth more here than a more capable colour model would be.
 *
 * ## What each control does
 *
 * Four of the six are a primitive each, and read exactly as their name suggests. Two are
 * not, and are worth being honest about:
 *
 *  - **Brilliance** is a tone-curve move in Photos: it opens the shadows, eases the
 *    highlights back, and adds a little local contrast. There is no CSS primitive for a
 *    curve, so it is approximated as *lift with a matching contrast reduction* — brighter
 *    without blowing out, which is the part of it people are reaching for. It will not
 *    recover a clipped sky.
 *  - **Warmth and tint** are white balance, which is properly a per-channel gain. What is
 *    available is `sepia` (which pushes the whole image toward orange) wound back by a
 *    `hue-rotate`, and that lands close enough on footage that is merely a bit cold or a
 *    bit green. It is not a colour-temperature control and does not pretend to be a
 *    Kelvin number.
 *
 * ## Ranges
 *
 * Every control is −1..1 with 0 at rest. The gains below are chosen so that ±1 is a
 * strong-but-usable move rather than a broken image: nobody drags a slider to the end
 * expecting to be punished for it, and a control whose useful range is its first 20% is a
 * control that feels wrong on a phone.
 */
const GAIN = {
  /** ±1 → ×1.6 / ×0.4, a little over half a stop each way. */
  exposure: 0.6,
  /** The lift, and the contrast given back so the highlights do not simply flatten. */
  brilliance: 0.32,
  brillianceContrast: 0.2,
  contrast: 0.5,
  saturation: 0.8,
  /** Sepia is a heavy primitive; a third of it is already a definite cast. */
  warmth: 0.32,
  /** Sepia flattens the original colour, so a warm or cool move gives some back. */
  warmthSaturation: 0.45,
  tintDegrees: 22,
} as const;

/**
 * `filter` value for a grade, or `'none'` when it would change nothing.
 *
 * Order matters — filter functions apply left to right — so white balance is settled
 * before saturation, and saturation is the last word. Grading a cast *after* boosting
 * colour amplifies whatever cast the footage already had.
 */
export function filterFor(value: ColorValue | null | undefined): string {
  if (!value || isNeutralColor(value)) return 'none';

  const parts: string[] = [];

  const brightness = (1 + value.exposure * GAIN.exposure) * (1 + value.brilliance * GAIN.brilliance);
  if (brightness !== 1) parts.push(`brightness(${round(brightness)})`);

  // Brilliance trades contrast for range in both directions: opening the shadows softens
  // the picture, and deepening them hardens it.
  const contrast = (1 + value.contrast * GAIN.contrast) * (1 - value.brilliance * GAIN.brillianceContrast);
  if (contrast !== 1) parts.push(`contrast(${round(contrast)})`);

  // Sepia only goes one way — toward orange. Cooling is therefore the same push spun half
  // a turn, which is the standard trick and lands convincingly on footage that is merely
  // a little cold or a little warm.
  if (value.warmth !== 0) {
    parts.push(`sepia(${round(Math.abs(value.warmth) * GAIN.warmth)})`);
    if (value.warmth < 0) parts.push('hue-rotate(180deg)');
  }

  // Positive tint is toward magenta, which is a rotation *against* the hue circle.
  if (value.tint !== 0) parts.push(`hue-rotate(${round(-value.tint * GAIN.tintDegrees)}deg)`);

  const saturation =
    (1 + value.saturation * GAIN.saturation) * (1 + Math.abs(value.warmth) * GAIN.warmthSaturation);
  if (saturation !== 1) parts.push(`saturate(${round(saturation)})`);

  return parts.length > 0 ? parts.join(' ') : 'none';
}

/** Clamp every control into range and fill in anything missing. Never throws. */
export function normalizeColor(value: Partial<ColorValue> | null | undefined): ColorValue {
  const out = { ...NEUTRAL_COLOR };
  if (!value) return out;
  for (const key of Object.keys(NEUTRAL_COLOR) as Array<keyof ColorValue>) {
    const given = value[key];
    if (typeof given === 'number' && Number.isFinite(given)) {
      out[key] = Math.max(-1, Math.min(1, given));
    }
  }
  return out;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * What one frame actually looks like, in the four numbers a grade is decided from.
 *
 * Separated from the pixels so the arithmetic can be tested without a canvas, and from the
 * decision so "what is in this frame" and "what should be done about it" stay different
 * questions. Everything is 0..1.
 */
export interface FrameStats {
  /** Luma at the 5th, 50th and 95th percentile. The black point, the midtone, the white. */
  black: number;
  mid: number;
  white: number;
  /** Mean of `(max − min) / max` per pixel: how colourful the frame is, ignoring exposure. */
  saturation: number;
  /** Channel means, for white balance. */
  red: number;
  green: number;
  blue: number;
}

/**
 * Measure an RGBA buffer.
 *
 * Percentiles rather than min and max, because one blown specular highlight or one black
 * pixel of letterboxing would otherwise decide the whole grade. A 256-bin histogram is
 * plenty: the controls it feeds are quantised far more coarsely than that.
 */
export function measureFrame(rgba: Uint8ClampedArray | Uint8Array): FrameStats {
  const bins = new Uint32Array(256);
  let saturation = 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;

  for (let at = 0; at + 3 < rgba.length; at += 4) {
    // Skip anything fully transparent — letterbox padding, mostly, which is not footage.
    if (rgba[at + 3]! < 8) continue;
    const r = rgba[at]!;
    const g = rgba[at + 1]!;
    const b = rgba[at + 2]!;

    // Rec.709 luma: the eye is not equally sensitive to the three channels, and a plain
    // average would call a saturated blue frame "dark" and try to brighten it.
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const bin = Math.min(255, Math.max(0, Math.round(luma)));
    bins[bin] = bins[bin]! + 1;

    const high = Math.max(r, g, b);
    const low = Math.min(r, g, b);
    saturation += high === 0 ? 0 : (high - low) / high;
    red += r;
    green += g;
    blue += b;
    count += 1;
  }

  if (count === 0) {
    return { black: 0, mid: 0.5, white: 1, saturation: 0, red: 0.5, green: 0.5, blue: 0.5 };
  }

  const at = (fraction: number): number => {
    const target = fraction * count;
    let seen = 0;
    for (let bin = 0; bin < 256; bin += 1) {
      seen += bins[bin]!;
      if (seen >= target) return bin / 255;
    }
    return 1;
  };

  return {
    black: at(0.05),
    mid: at(0.5),
    white: at(0.95),
    saturation: saturation / count,
    red: red / count / 255,
    green: green / count / 255,
    blue: blue / count / 255,
  };
}

/**
 * A grade for a frame that looks like this.
 *
 * Deliberately timid. An auto-adjust that produces an obviously nicer picture two times in
 * three and a lurid one the third time is worse than useless, because it destroys the trust
 * that makes the button worth tapping at all — and everything it does here is a starting
 * point the sliders sit right underneath.
 *
 * The four judgements, in order of how confident they are:
 *
 *  1. **Range.** If the darkest 5% never gets near black and the brightest 5% never gets
 *     near white, the shot is flat — the single most common thing wrong with phone footage
 *     shot indoors, and the one an automatic fix is least likely to get wrong.
 *  2. **Exposure.** Pull the midtone toward the middle. Weakly, because "correctly exposed"
 *     depends on intent: a night shot is meant to be dark.
 *  3. **Saturation.** Only ever a lift, and only when the frame is genuinely drab. Pulling
 *     saturation down automatically would fight footage that is colourful on purpose.
 *  4. **White balance.** From the channel means, on the grey-world assumption — that a
 *     whole frame averages out neutral. It is wrong about a sunset and it is right about a
 *     kitchen, so it gets the smallest gain of the four.
 */
export function autoColor(stats: FrameStats): ColorValue {
  const out = { ...NEUTRAL_COLOR };
  const clamp = (value: number, limit: number): number =>
    Math.max(-limit, Math.min(limit, Number(value.toFixed(3))));

  // Flat range: the gap between black and white points, against the full range it could use.
  const range = Math.max(0.05, stats.white - stats.black);
  out.contrast = clamp((1 - range) * 0.9, 0.5);

  // A raised black point reads as haze, and lowering it is the other half of the same fix;
  // a crushed one wants the shadows opened instead. Brilliance does both, by sign.
  out.brilliance = clamp((0.06 - stats.black) * 1.6, 0.4);

  out.exposure = clamp((0.5 - stats.mid) * 0.7, 0.35);

  out.saturation = clamp(Math.max(0, 0.32 - stats.saturation) * 1.6, 0.3);

  // Grey world: a frame whose red mean exceeds its blue mean is warm, and wants cooling.
  const luma = (stats.red + stats.green + stats.blue) / 3 || 1;
  out.warmth = clamp(((stats.blue - stats.red) / luma) * 0.8, 0.25);
  out.tint = clamp((((stats.red + stats.blue) / 2 - stats.green) / luma) * 0.8, 0.2);

  return out;
}
