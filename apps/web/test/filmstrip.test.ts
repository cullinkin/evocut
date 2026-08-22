import { describe, expect, it } from 'vitest';
import { tooHeavyToSeek } from '../src/filmstrip.ts';

/**
 * Which recordings a phone can afford to seek through eighty times.
 *
 * Extraction opens a *third* `<video>` on the source and seeks it once per thumbnail.
 * Against a twelve-second clip that is free; against half an hour of 4K, with the preview
 * already holding two decoders on the same five-gigabyte file, it is what killed the tab —
 * the crash breadcrumb named `measure:open`, which is the moment that element is handed the
 * recording, sixteen seconds before the process ended.
 *
 * So the rule: thumbnails come from a proxy, or from a recording small enough to seek.
 */
describe('deciding what is too heavy to seek', () => {
  const clip = { durationUs: 12_000_000, width: 1080, height: 1920 };

  it('lets an ordinary phone clip through', () => {
    expect(tooHeavyToSeek(clip)).toBe(false);
  });

  it('refuses 4K, however short the take', () => {
    // A 4K frame is expensive to decode whether there are ten of them or ten thousand.
    expect(tooHeavyToSeek({ ...clip, width: 2160, height: 3840 })).toBe(true);
  });

  it('refuses a long recording, however small the frame', () => {
    // Length means a large file, which means keyframes far apart and a slow seek wherever
    // it lands. The reported recording is twenty-seven minutes.
    expect(tooHeavyToSeek({ ...clip, durationUs: 27 * 60 * 1_000_000 })).toBe(true);
    expect(tooHeavyToSeek({ ...clip, durationUs: 4 * 60 * 1_000_000 })).toBe(false);
  });

  it('treats a recording that will not say as light', () => {
    // A source with no measured video is usually a short import; refusing on no evidence
    // would take the filmstrip away from footage that never had a problem.
    expect(tooHeavyToSeek({ durationUs: 30_000_000 })).toBe(false);
  });
});
