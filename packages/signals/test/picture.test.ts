import { describe, expect, it } from 'vitest';
import { analyzePicture, type FrameWeights } from '../src/picture.js';

/**
 * The curve a person aims a keyframe at.
 *
 * Reported after a session spent framing a knife cutting a box seal: "While the audio is
 * good, it isn't perfect for making these keyframe decisions. I really need to key off of
 * motion and right now it's just not reliable."
 *
 * The measurement behind this: a clip built to alternate two seconds of movement with two
 * seconds of a held frame, encoded the way a phone encodes, weighs about 3,400 bytes a
 * frame while moving and 23 while still — a correlation of 0.88 against the actual mean
 * absolute difference between the decoded frames. That is what these tests hold the shape
 * of: busy reads busy, still reads still, and nothing else in the container is mistaken
 * for either.
 */
const HOP = 40_000;

function weighing(sizes: number[], options: { keyEvery?: number; hopUs?: number } = {}): FrameWeights {
  const hopUs = options.hopUs ?? HOP;
  const keyEvery = options.keyEvery ?? 0;
  return {
    hopUs,
    sizes,
    times: sizes.map((_, index) => index * hopUs),
    sync: sizes.map((_, index) => (keyEvery > 0 ? index % keyEvery === 0 : index === 0)),
  };
}

describe('the picture signal', () => {
  it('reads busy as busy and still as still', () => {
    const still = new Array(10).fill(30);
    const busy = new Array(10).fill(3400);
    const picture = analyzePicture(weighing([...still, ...busy, ...still]))!;

    expect(picture.hopUs).toBe(HOP);
    expect(picture.weight).toHaveLength(30);
    expect(picture.weight.slice(1, 10).every((value) => value < 100)).toBe(true);
    expect(picture.weight.slice(11, 19).every((value) => value > 1000)).toBe(true);
    expect(picture.peakBytes).toBe(3400);
  });

  it('bridges keyframes rather than reading them as movement', () => {
    /*
      A keyframe is a whole picture — tens of times the size of the differences around it —
      and it lands every second or two whether or not anything is happening. Left in, the
      curve is a comb of spikes on a fixed beat, which looks exactly like rhythm.
    */
    const sizes = [80_000, 40, 44, 42, 80_000, 46, 48, 44];
    const picture = analyzePicture(weighing(sizes, { keyEvery: 4 }))!;
    expect(Math.max(...picture.weight)).toBeLessThan(100);
  });

  it('says so when every frame is a keyframe, because then it is not movement', () => {
    const picture = analyzePicture(weighing([9000, 9100, 8800], { keyEvery: 1 }))!;
    expect(picture.allIntra).toBe(true);
    // Left as measured: the caller decides whether picture complexity is worth drawing.
    expect(picture.weight[0]).toBe(9000);
  });

  it('holds a value across a dropped frame instead of reading it as stillness', () => {
    // A phone that dropped its rate in low light writes long gaps. A gap is the same
    // picture held, not a frame that weighed nothing.
    const picture = analyzePicture({
      hopUs: HOP,
      sizes: [3000, 3200, 3100],
      times: [0, HOP, HOP * 5],
      sync: [true, false, false],
    })!;
    expect(picture.weight).toHaveLength(6);
    expect(picture.weight.every((value) => value > 2000)).toBe(true);
  });

  it('gives back nothing rather than a curve of one point', () => {
    expect(analyzePicture(weighing([1000]))).toBe(null);
    expect(analyzePicture({ hopUs: HOP, sizes: [], times: [], sync: [] })).toBe(null);
  });

  it('refuses a nonsense frame rate rather than allocating for it', () => {
    // A misparsed table can claim a one-microsecond hop, which across a half-hour take is
    // eighteen hundred million slots. The grid is clamped to something a recording could be.
    const picture = analyzePicture({ ...weighing([100, 200, 300]), hopUs: 1 })!;
    expect(picture.hopUs).toBeGreaterThanOrEqual(1_000);
  });
});
