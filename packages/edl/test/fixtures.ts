import { makeIdFactory } from '../src/schema/common.js';
import type { Source } from '../src/schema/source.js';
import { createClip, createTimeline, createTrack, projectFromSource } from '../src/factory.js';
import { FPS_30, secondsToMicros } from '../src/time.js';
import type { Timeline } from '../src/schema/timeline.js';
import type { Project } from '../src/schema/project.js';

/** Deterministic ids and clock, so every assertion in the suite is exact. */
export function testDeps(seed = 't') {
  let tick = 0;
  return {
    newId: makeIdFactory(seed),
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
  };
}

export const S = secondsToMicros;

/** A 60-second portrait phone recording. */
export function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'src_take1',
    locator: { kind: 'opfs', path: 'media/take1.mp4' },
    name: 'take1.mp4',
    duration: S(60),
    video: {
      width: 1080,
      height: 1920,
      frameRate: FPS_30,
      rotation: 0,
      variableFrameRate: false,
    },
    audio: { sampleRate: 48000, channels: 2 },
    mimeType: 'video/mp4',
    ...overrides,
  };
}

/**
 * The shape a coarse pass actually produces: three keeper regions pulled out of one
 * 60s take, with the dead air between them already dropped.
 */
export function makeCoarseTimeline(): Timeline {
  const d = testDeps();
  const clips = [
    createClip({ sourceId: 'src_take1', sourceIn: S(2), sourceOut: S(10), label: 'intro' }, d),
    createClip({ sourceId: 'src_take1', sourceIn: S(18), sourceOut: S(30), label: 'demo' }, d),
    createClip({ sourceId: 'src_take1', sourceIn: S(44), sourceOut: S(52), label: 'outro' }, d),
  ];
  return createTimeline({ tracks: [createTrack({ kind: 'video', name: 'Video', clips }, d)] }, d);
}

export function makeCoarseProject(): Project {
  const source = makeSource();
  const project = projectFromSource(source, {}, testDeps());
  return { ...project, timeline: makeCoarseTimeline() };
}

/** Ids assigned by `makeCoarseTimeline`, in track order. */
export const COARSE_CLIP_IDS = ['clp_t1', 'clp_t2', 'clp_t3'] as const;
