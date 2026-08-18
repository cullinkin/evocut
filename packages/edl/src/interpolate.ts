import type { Easing } from './schema/common.js';
import type { Effect, TransformValue } from './schema/effects.js';

/**
 * Keyframe sampling.
 *
 * Lives in the EDL package rather than the renderer because two other things need it:
 * splitting a clip has to bake the interpolated value at the cut point into both halves,
 * and the review UI has to draw the curve the model proposed. All three must agree
 * exactly, or a preview will not match its render.
 */

export interface Keyframe<T> {
  t: number;
  value: T;
  easing: Easing;
}

/** Normalized easing curves. Input and output are both 0..1. */
export function ease(kind: Easing, t: number): number {
  const x = Math.min(1, Math.max(0, t));
  switch (kind) {
    case 'linear':
      return x;
    case 'hold':
      return 0;
    case 'easeIn':
      return x * x;
    case 'easeOut':
      return 1 - (1 - x) * (1 - x);
    case 'easeInOut':
      return x < 0.5 ? 2 * x * x : 1 - ((-2 * x + 2) * (-2 * x + 2)) / 2;
  }
}

export function lerpNumber(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpTransform(a: TransformValue, b: TransformValue, t: number): TransformValue {
  return {
    scale: lerpNumber(a.scale, b.scale, t),
    x: lerpNumber(a.x, b.x, t),
    y: lerpNumber(a.y, b.y, t),
    rotation: lerpNumber(a.rotation, b.rotation, t),
  };
}

/**
 * Value of a keyframe track at time `t` (clip-output microseconds).
 * Clamps outside the track: before the first keyframe holds the first value, after the
 * last holds the last. Keyframes are assumed sorted by `t`.
 */
export function sampleKeyframes<T>(
  keyframes: ReadonlyArray<Keyframe<T>>,
  t: number,
  lerp: (a: T, b: T, amount: number) => T,
): T {
  if (keyframes.length === 0) throw new Error('sampleKeyframes: empty keyframe track');

  const first = keyframes[0]!;
  if (t <= first.t) return first.value;

  const last = keyframes[keyframes.length - 1]!;
  if (t >= last.t) return last.value;

  let index = 0;
  for (let i = 0; i < keyframes.length - 1; i++) {
    if (t >= keyframes[i]!.t && t < keyframes[i + 1]!.t) {
      index = i;
      break;
    }
  }

  const from = keyframes[index]!;
  const to = keyframes[index + 1]!;
  const span = to.t - from.t;
  if (span <= 0) return to.value;

  return lerp(from.value, to.value, ease(from.easing, (t - from.t) / span));
}

export function sampleTransform(keyframes: ReadonlyArray<Keyframe<TransformValue>>, t: number): TransformValue {
  return sampleKeyframes(keyframes, t, lerpTransform);
}

export function sampleNumber(keyframes: ReadonlyArray<Keyframe<number>>, t: number): number {
  return sampleKeyframes(keyframes, t, lerpNumber);
}

/**
 * Split an effect at `offset` (clip-output microseconds) into the halves for a split clip.
 *
 * A boundary keyframe carrying the interpolated value is inserted on both sides, so a
 * zoom that was mid-push when the clip was cut continues from the same framing instead of
 * jumping back to the nearest authored keyframe.
 */
export function splitEffect(effect: Effect, offset: number): [Effect, Effect] {
  // Nothing to interpolate: both halves of the shot were lit the same way and cropped the
  // same way, and a split is not a reason for either to change.
  if (effect.type === 'crop' || effect.type === 'color') {
    return [{ ...effect }, { ...effect }];
  }

  if (effect.type === 'transform') {
    const boundary = sampleTransform(effect.keyframes, offset);
    return [
      { ...effect, keyframes: leftKeyframes(effect.keyframes, offset, boundary) },
      { ...effect, keyframes: rightKeyframes(effect.keyframes, offset, boundary) },
    ];
  }

  if (effect.type === 'volume') {
    const boundary = sampleNumber(effect.keyframes, offset);
    return [
      { ...effect, keyframes: leftKeyframes(effect.keyframes, offset, boundary) },
      { ...effect, keyframes: rightKeyframes(effect.keyframes, offset, boundary) },
    ];
  }

  const boundary = sampleNumber(effect.keyframes, offset);
  return [
    { ...effect, keyframes: leftKeyframes(effect.keyframes, offset, boundary) },
    { ...effect, keyframes: rightKeyframes(effect.keyframes, offset, boundary) },
  ];
}

/**
 * Move an effect's keyframes so they stay on the footage they were placed on.
 *
 * Keyframes are stored in clip-output time, which is a coordinate that *moves* when the
 * clip is trimmed or retimed: extend the head by five frames and clip-time 0 is now five
 * frames earlier in the recording, so a key that was on a particular gesture is now five
 * frames late. Reported exactly that way — "I did a drag at the beginning of the clip and it
 * seemed to shift all of the keyframes" — and it is the one thing a keyframe must never do.
 *
 * `shiftUs` is how far the clip's content moved in output time: `(oldSourceIn - newSourceIn)
 * / speed`. Positive when the head was extended, because there is now more clip before
 * everything.
 *
 * Keys pushed outside the clip are not simply dropped. The framing at the new edge is
 * sampled first and pinned there, so trimming into the middle of a push-in leaves the shot
 * starting at the size it had reached rather than snapping back to whatever the nearest
 * surviving key happened to say. Same rule, and the same reason, as splitting.
 */
export function retimeEffect(effect: Effect, shiftUs: number, lengthUs: number): Effect {
  if (effect.type === 'crop' || effect.type === 'color') return { ...effect };

  if (effect.type === 'transform') {
    return { ...effect, keyframes: retimeKeys(effect.keyframes, shiftUs, lengthUs, sampleTransform) };
  }
  return { ...effect, keyframes: retimeKeys(effect.keyframes, shiftUs, lengthUs, sampleNumber) };
}

/**
 * Scale an effect's keyframe times, for a speed change.
 *
 * The same rule as `retimeEffect` under a different transformation: output time is the
 * coordinate that moved, so the numbers have to move with it or every move slides off its
 * moment.
 */
export function stretchEffect(effect: Effect, factor: number, lengthUs: number): Effect {
  if (effect.type === 'crop' || effect.type === 'color') return { ...effect };
  if (!Number.isFinite(factor) || factor <= 0) return { ...effect };

  const scale = <T,>(keys: ReadonlyArray<Keyframe<T>>) =>
    keys.map((keyframe) => ({ ...keyframe, t: Math.round(keyframe.t * factor) }));

  if (effect.type === 'transform') {
    return { ...effect, keyframes: retimeKeys(scale(effect.keyframes), 0, lengthUs, sampleTransform) };
  }
  return { ...effect, keyframes: retimeKeys(scale(effect.keyframes), 0, lengthUs, sampleNumber) };
}

function retimeKeys<T>(
  keyframes: ReadonlyArray<Keyframe<T>>,
  shiftUs: number,
  lengthUs: number,
  sample: (keys: ReadonlyArray<Keyframe<T>>, t: number) => T,
): Array<Keyframe<T>> {
  if (keyframes.length === 0) return [];

  let out: Array<Keyframe<T>> = keyframes
    .map((keyframe) => ({ ...keyframe, t: Math.round(keyframe.t + shiftUs) }))
    .sort((a, b) => a.t - b.t);

  if (out[0]!.t < 0) {
    const boundary = sample(out, 0);
    const easing = out.filter((k) => k.t <= 0).at(-1)?.easing ?? 'linear';
    out = [{ t: 0, value: boundary, easing }, ...out.filter((k) => k.t > 0)];
  }

  const last = out.at(-1)!;
  if (last.t > lengthUs) {
    const boundary = sample(out, lengthUs);
    const easing = out.filter((k) => k.t <= lengthUs).at(-1)?.easing ?? 'linear';
    out = [...out.filter((k) => k.t < lengthUs), { t: lengthUs, value: boundary, easing }];
  }

  return out;
}

function leftKeyframes<T>(keyframes: ReadonlyArray<Keyframe<T>>, offset: number, boundary: T): Array<Keyframe<T>> {
  const kept = keyframes.filter((k) => k.t < offset).map((k) => ({ ...k }));
  const easing = keyframes.filter((k) => k.t < offset).at(-1)?.easing ?? 'linear';
  kept.push({ t: offset, value: boundary, easing });
  return kept;
}

function rightKeyframes<T>(keyframes: ReadonlyArray<Keyframe<T>>, offset: number, boundary: T): Array<Keyframe<T>> {
  const easing = keyframes.filter((k) => k.t <= offset).at(-1)?.easing ?? 'linear';
  const shifted = keyframes.filter((k) => k.t > offset).map((k) => ({ ...k, t: k.t - offset }));
  return [{ t: 0, value: boundary, easing }, ...shifted];
}
