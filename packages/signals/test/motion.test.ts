import { describe, expect, it } from 'vitest';
import { analyzeMotion, frameDifference, lumaFromRgba, type LumaFrame } from '../src/motion.js';

const SIZE = 8;

function frame(t: number, fill: number | ((x: number, y: number) => number)): LumaFrame {
  const luma = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      luma[y * SIZE + x] = typeof fill === 'number' ? fill : fill(x, y);
    }
  }
  return { t, width: SIZE, height: SIZE, luma };
}

describe('frameDifference', () => {
  it('is zero for identical frames and one for black against white', () => {
    expect(frameDifference(frame(0, 128), frame(1, 128))).toBe(0);
    expect(frameDifference(frame(0, 0), frame(1, 255))).toBe(1);
  });

  it('refuses to compare frames of different sizes rather than guessing', () => {
    const small = { t: 0, width: 2, height: 2, luma: new Uint8Array(4) };
    expect(frameDifference(small, frame(1, 200))).toBe(0);
  });
});

describe('analyzeMotion', () => {
  it('finds the held stretch in the middle of a moving take', () => {
    // Four seconds of change, three seconds of an unchanging frame, three more of change.
    const frames: LumaFrame[] = [];
    let at = 0;
    for (let i = 0; i < 4; i += 1) frames.push(frame(at++ * 1_000_000, (x, y) => (x * 7 + y * 13 + i * 90) % 255));
    for (let i = 0; i < 3; i += 1) frames.push(frame(at++ * 1_000_000, 120));
    for (let i = 0; i < 3; i += 1) frames.push(frame(at++ * 1_000_000, (x, y) => (x * 5 + y * 3 + i * 70) % 255));

    const signals = analyzeMotion(frames)!;
    expect(signals.hopUs).toBe(1_000_000);
    expect(signals.still).toHaveLength(1);
    // The held frames sit at 4, 5 and 6 seconds, so nothing changes between 4 and 6.
    expect(signals.still[0]!.start / 1e6).toBeCloseTo(4, 1);
    expect(signals.still[0]!.end / 1e6).toBeCloseTo(6, 1);
  });

  it('does not call the first frame still just because it has no predecessor', () => {
    // The opening frame has nothing to be compared against. Reporting zero movement for
    // it would mark every recording as opening on a locked-off shot.
    const frames = Array.from({ length: 6 }, (_, i) =>
      frame(i * 1_000_000, (x, y) => (x * 11 + y * 17 + i * 100) % 255),
    );
    expect(analyzeMotion(frames)!.still).toEqual([]);
  });

  it('reports nothing rather than guessing from a single frame', () => {
    expect(analyzeMotion([frame(0, 10)])).toBeNull();
    expect(analyzeMotion([])).toBeNull();
  });

  it('offsets the regions by where the frames actually start', () => {
    // Frame extraction may not begin at zero; the regions have to be in source time.
    const frames = Array.from({ length: 5 }, (_, i) => frame(5_000_000 + i * 1_000_000, 90));
    const signals = analyzeMotion(frames)!;
    expect(signals.still[0]!.start).toBe(5_000_000);
  });
});

describe('lumaFromRgba', () => {
  it('weights the channels the way an eye does', () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);
    const [red, green] = lumaFromRgba(rgba, 2, 1);
    // Green reads far brighter than red at the same value; that is the whole point of
    // using luma rather than an average.
    expect(green!).toBeGreaterThan(red!);
    expect(red!).toBeCloseTo(76, -1);
    expect(green!).toBeCloseTo(150, -1);
  });
});
