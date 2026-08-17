import { describe, expect, it } from 'vitest';
import {
  MAX_SCRUB_INTERVAL_MS,
  SCRUB_SEEK_INTERVAL_MS,
  STALLED_SEEK_MS,
  newScrubPace,
  nextInterval,
  noteSeekIssued,
  noteSeekLanded,
  shouldSeekNow,
} from '../src/scrub.ts';
import { MAX_THUMBNAILS_PER_CLIP, thumbnailSlots } from '../src/filmstrip.ts';

/**
 * The pacing rule, stated exactly.
 *
 * The browser spec cannot test this, and it is worth saying why rather than leaving the gap
 * to be rediscovered: making a seek *slow* in a test means having media that is slow to
 * seek, and the fixture is a twelve-second 360p webm where a keyframe is always nearby. CPU
 * throttling does not help — it starves the test's own rAF loop long before it slows the
 * decode, so the sabotaged run issued zero seeks and proved nothing. Here the timings are
 * numbers, so "a 900ms seek" is one line.
 *
 * The scenario that matters throughout is the one from the real project: a 5 GB 4K file
 * where one keyframe seek costs most of a second, scrubbed with a momentum flick that emits
 * events every 16ms.
 */

/** A seek that is in flight. The element's `seeking` is true. */
const SEEKING = true;
/** Idle. */
const IDLE = false;

describe('one seek in flight', () => {
  it('refuses a second seek while the first is still going', () => {
    let pace = noteSeekIssued(newScrubPace(), 1_000);

    // The gesture keeps emitting for the whole second the seek takes. Every one of these is
    // an event that used to become a seek, which is exactly how the queue got built.
    for (let now = 1_016; now < 2_000; now += 16) {
      expect(shouldSeekNow(pace, now, SEEKING)).toBe(false);
    }

    pace = noteSeekLanded(pace, 2_000);
    expect(shouldSeekNow(pace, 2_000, IDLE)).toBe(true);
  });

  it('counts a momentum flick down from sixty a second to one', () => {
    /*
      The whole bug in one number. A 1000ms seek, a gesture emitting at 60Hz for five
      seconds: unpaced that is 300 seeks at an element that can finish five.
    */
    const SEEK_COST = 1_000;
    let pace = newScrubPace();
    let seeking = false;
    let landsAt = 0;
    let issued = 0;

    for (let now = 0; now <= 5_000; now += 16) {
      if (seeking && now >= landsAt) {
        seeking = false;
        pace = noteSeekLanded(pace, now);
      }
      if (shouldSeekNow(pace, now, seeking)) {
        pace = noteSeekIssued(pace, now);
        seeking = true;
        landsAt = now + SEEK_COST;
        issued += 1;
      }
    }

    // Five seconds, a second a seek: five, maybe six. Not three hundred.
    expect(issued).toBeLessThanOrEqual(6);
    expect(issued).toBeGreaterThanOrEqual(4);
    // And it learned what the media costs rather than being told.
    expect(pace.intervalMs).toBeGreaterThan(500);
  });

  it('gives up on a seek that is never coming back', () => {
    const pace = noteSeekIssued(newScrubPace(), 1_000);

    // Still waiting, still patient.
    expect(shouldSeekNow(pace, 1_000 + STALLED_SEEK_MS - 1, SEEKING)).toBe(false);
    // Past the timeout the element is not busy, it is wedged — a stalled range request, most
    // likely — and another seek goes over the top of it. Without this the preview would be
    // frozen for the rest of the session rather than for two seconds.
    expect(shouldSeekNow(pace, 1_000 + STALLED_SEEK_MS, SEEKING)).toBe(true);
  });

  it('does not hold up the next seek once the last one landed', () => {
    // `seeking` false is the element saying it is free, and being free is not enough on its
    // own — the interval still applies, or a file with instant seeks would be scrubbed at
    // 60Hz and we would be back to a queue on the next slow one.
    let pace = noteSeekIssued(newScrubPace(), 1_000);
    pace = noteSeekLanded(pace, 1_010);
    expect(shouldSeekNow(pace, 1_020, IDLE)).toBe(false);
    expect(shouldSeekNow(pace, 1_000 + SCRUB_SEEK_INTERVAL_MS, IDLE)).toBe(true);
  });
});

describe('the interval is learned', () => {
  it('starts optimistic', () => {
    expect(newScrubPace().intervalMs).toBe(SCRUB_SEEK_INTERVAL_MS);
  });

  it('moves toward what the seek actually cost', () => {
    const slower = nextInterval(SCRUB_SEEK_INTERVAL_MS, 600);
    expect(slower).toBeGreaterThan(SCRUB_SEEK_INTERVAL_MS);
    expect(slower).toBeLessThan(600);

    // Eased, so one slow seek does not set the pace for the rest of the gesture — but a run
    // of them converges on the truth.
    let interval = SCRUB_SEEK_INTERVAL_MS;
    for (let i = 0; i < 12; i += 1) interval = nextInterval(interval, 600);
    expect(Math.round(interval)).toBeCloseTo(600, -1);
  });

  it('comes back down when the media does', () => {
    // Seeks are cheap once the decoder is warm and the thumb is near frames it already has.
    // The scrubber should get its responsiveness back rather than staying slow all session.
    let interval = MAX_SCRUB_INTERVAL_MS;
    for (let i = 0; i < 20; i += 1) interval = nextInterval(interval, 5);
    expect(interval).toBe(SCRUB_SEEK_INTERVAL_MS);
  });

  it('never goes below the floor or above the ceiling', () => {
    expect(nextInterval(SCRUB_SEEK_INTERVAL_MS, 0)).toBe(SCRUB_SEEK_INTERVAL_MS);
    // A twenty-second stall must not turn the scrubber off for the rest of the session.
    expect(nextInterval(SCRUB_SEEK_INTERVAL_MS, 20_000)).toBe(MAX_SCRUB_INTERVAL_MS);
    // Nor may a nonsense measurement — a clock that went backwards — undercut the floor.
    expect(nextInterval(SCRUB_SEEK_INTERVAL_MS, -500)).toBe(SCRUB_SEEK_INTERVAL_MS);
  });

  it('learns nothing from a seek it did not issue', () => {
    /*
      `seeked` fires for playback, for the ping-pong handoff, and for the exact seek at the
      end of a gesture. None of those are scrub seeks, and measuring them would teach the
      pace a number about something else entirely — a handoff preroll that happens to take
      800ms would slow the next scrub to a crawl for no reason.
    */
    const idle = newScrubPace();
    expect(noteSeekLanded(idle, 9_999)).toEqual(idle);
  });
});

/**
 * How many thumbnails a clip block draws.
 *
 * Extracted and tested because the unbounded version was the single largest cost in the
 * editor and nothing caught it: it is invisible at the zoom the tests used and catastrophic
 * at the zoom the editor now reaches.
 */
describe('thumbnail slots', () => {
  it('draws one per 56 pixels at an ordinary zoom', () => {
    // A four-second clip at 40px/s: 160px, and a strip with a frame a second.
    expect(thumbnailSlots(160, 4_000_000, 1_000_000)).toBe(3);
  });

  it('never asks for more pictures than the filmstrip has', () => {
    /*
      The case that mattered. A thirty-second clip at full zoom is thirty-five thousand
      pixels wide, and on a twenty-seven minute source the filmstrip holds a frame every
      twenty seconds — so there are two pictures to draw. The old rule drew six hundred and
      thirty copies of those two, per clip, across fifty clips.
    */
    expect(thumbnailSlots(35_000, 30_000_000, 20_000_000)).toBe(2);
    // A short source, where the strip is dense: thirty seconds at a frame a second is
    // thirty pictures, and thirty is what gets drawn — not six hundred, and not the cap.
    expect(thumbnailSlots(35_000, 30_000_000, 1_000_000)).toBe(30);
  });

  it('is bounded whatever it is asked', () => {
    expect(thumbnailSlots(1_000_000, 600_000_000, 1_000_000)).toBe(MAX_THUMBNAILS_PER_CLIP);
    expect(thumbnailSlots(0, 0, 1_000_000)).toBe(1);
    // No strip yet: fall back to the width, still capped.
    expect(thumbnailSlots(300, 4_000_000, Number.POSITIVE_INFINITY)).toBe(5);
  });
});
