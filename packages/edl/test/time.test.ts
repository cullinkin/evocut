import { describe, expect, it } from 'vitest';
import {
  FPS_23_976,
  FPS_29_97,
  FPS_30,
  formatTimecode,
  frameToMicros,
  isFrameAligned,
  microsToFrame,
  parseTimecode,
  secondsToMicros,
  snapToFrame,
} from '../src/time.js';

describe('frame conversion', () => {
  it('round-trips frame indices at integer rates', () => {
    for (const frame of [0, 1, 29, 30, 1799]) {
      expect(microsToFrame(frameToMicros(frame, FPS_30), FPS_30)).toBe(frame);
    }
  });

  it('round-trips frame indices at NTSC rates', () => {
    for (const frame of [0, 1, 29, 30, 1799, 107892]) {
      expect(microsToFrame(frameToMicros(frame, FPS_29_97), FPS_29_97)).toBe(frame);
    }
  });

  it('keeps NTSC exact rather than nominal', () => {
    // 107892 frames is one hour of *drop-frame timecode*. Treating the rate as the float
    // 29.97 makes that exactly one wall-clock hour; the true 30000/1001 rate makes it
    // 3.6ms short. That gap per hour is the whole reason drop-frame timecode exists, and
    // it is invisible unless the rate is stored as a rational.
    expect(frameToMicros(107892, FPS_29_97)).toBe(3_599_996_400);
    expect(Math.round((107892 / 29.97) * 1_000_000)).toBe(3_600_000_000);
  });

  it('places a time inside the frame that contains it', () => {
    const frameDur = 1_000_000 / 30;
    expect(microsToFrame(Math.floor(frameDur) - 1, FPS_30)).toBe(0);
    expect(microsToFrame(Math.ceil(frameDur) + 1, FPS_30)).toBe(1);
  });
});

describe('snapToFrame', () => {
  it('rounds to the nearest boundary by default', () => {
    expect(snapToFrame(16_000, FPS_30)).toBe(0);
    expect(snapToFrame(20_000, FPS_30)).toBe(frameToMicros(1, FPS_30));
  });

  it('honours floor and ceil', () => {
    expect(snapToFrame(20_000, FPS_30, 'floor')).toBe(0);
    expect(snapToFrame(1_000, FPS_30, 'ceil')).toBe(frameToMicros(1, FPS_30));
  });

  it('reports alignment', () => {
    expect(isFrameAligned(frameToMicros(12, FPS_23_976), FPS_23_976)).toBe(true);
    expect(isFrameAligned(frameToMicros(12, FPS_23_976) + 500, FPS_23_976)).toBe(false);
  });
});

describe('timecode', () => {
  it('formats with milliseconds', () => {
    expect(formatTimecode(secondsToMicros(83.5))).toBe('00:01:23.500');
    expect(formatTimecode(0)).toBe('00:00:00.000');
    expect(formatTimecode(secondsToMicros(3661.25))).toBe('01:01:01.250');
  });

  it('formats compactly and with frames', () => {
    expect(formatTimecode(secondsToMicros(83.5), undefined, { compact: true })).toBe('1:23.500');
    expect(formatTimecode(secondsToMicros(83.5), FPS_30, { frames: true })).toBe('00:01:23:15');
  });

  it('formats negative times', () => {
    expect(formatTimecode(-secondsToMicros(1.5))).toBe('-00:00:01.500');
  });

  it('parses every accepted form', () => {
    expect(parseTimecode('00:01:23.500')).toBe(secondsToMicros(83.5));
    expect(parseTimecode('1:23.5')).toBe(secondsToMicros(83.5));
    expect(parseTimecode('83')).toBe(secondsToMicros(83));
    expect(parseTimecode('00:01:23,500')).toBe(secondsToMicros(83.5));
    expect(parseTimecode('00:01:23:15', FPS_30)).toBe(secondsToMicros(83.5));
  });

  it('round-trips through formatting', () => {
    const us = secondsToMicros(1234.567);
    expect(parseTimecode(formatTimecode(us))).toBe(us);
  });

  it('returns null rather than throwing on junk', () => {
    // This parses model and user input, so a bad value must be a value, not an exception.
    expect(parseTimecode('halfway through')).toBeNull();
    expect(parseTimecode('')).toBeNull();
    expect(parseTimecode('00:01:23:15')).toBeNull(); // frame form needs a rate
  });
});
