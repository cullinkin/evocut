import { useEffect, useState } from 'react';
import { lumaFromRgba } from '@evocut/signals';

/**
 * Filmstrip thumbnails for the timeline.
 *
 * Blocks of colour are not an editor. Knowing *where you are* in a take is the whole job
 * of a timeline, and on a phone — where the preview is small and the timeline is the
 * thing under your thumb — it is the only way to aim a cut.
 *
 * Frames are extracted for the **whole source**, not per clip, and cached by source id.
 * Trimming a clip then costs nothing: it changes which cached frames are visible, rather
 * than invalidating a strip. It also means two clips from the same take share one strip.
 *
 * Extraction is a seek-and-draw loop, which is slow on a phone, so it runs in the
 * background and the UI renders whatever has arrived. A timeline with half a filmstrip is
 * useful; a timeline that blocks until all of it is ready is not.
 */
export interface Frame {
  /** Presentation time within the source, in microseconds. */
  t: number;
  url: string;
}

/** A frame reduced to a tiny greyscale bitmap, for the motion signal. */
export interface LumaSample {
  t: number;
  width: number;
  height: number;
  luma: Uint8Array;
}

export interface Filmstrip {
  frames: Frame[];
  /** Ordered by time. Sampled far more finely than the thumbnails; see below. */
  luma: LumaSample[];
  /** The thumbnails are complete. */
  ready: boolean;
  /** The motion sampling is complete too — it runs on after the strip is usable. */
  motionReady: boolean;
  /** Aspect ratio of the extracted frames, for laying out the strip. */
  aspect: number;
}

const EMPTY: Filmstrip = { frames: [], luma: [], ready: false, motionReady: false, aspect: 9 / 16 };

/** Cap on thumbnails per source: enough to read a take at a glance, cheap on a phone. */
const MAX_FRAMES = 80;
const MIN_INTERVAL_US = 1_000_000;

/**
 * Motion is sampled on its own schedule, and far more finely than the strip.
 *
 * These used to be one number, and that quietly broke the motion signal on anything long.
 * Eighty frames across a 27-minute recording is one sample every twenty seconds, and at
 * that spacing "this shot is static" is not a measurement — two frames twenty seconds
 * apart are unrelated pictures. The signals pass duly reported four still regions for the
 * whole take and the refinement pass had nothing to work with.
 *
 * Thumbnails are a display budget: eighty is what fits under a thumb. Motion is a
 * measurement budget: it wants the shortest interval a phone can afford to seek to, which
 * is what makes 600 samples at no less than half a second a different number from 80.
 */
const MAX_LUMA_SAMPLES = 600;
const MIN_LUMA_INTERVAL_US = 500_000;
/**
 * Frames are captured well above their display size.
 *
 * The lane is 64 CSS px tall on a 3x screen, so a slot is ~190 device pixels wide. Phone
 * footage is portrait, so a frame captured at 56px tall is only ~31px wide — upscaled six
 * times on an iPhone, which is what made the strip look like smeared paint rather than
 * video. 144 gives ~81px for 9:16 and reads as an actual picture.
 */
const FRAME_HEIGHT = 144;
/**
 * How long to wait for one seek before giving up on that frame.
 *
 * Generous, because the alternative is what happened on a real 5.2 GB recording: this was
 * four seconds, the audio demuxer was reading the same file over the same range server at
 * the same time, seeks took longer than that, and the *first* timeout aborted the entire
 * pass — so the motion signal came back empty for a whole session and nothing said why.
 * A slow seek should cost one sample, not the recording.
 */
const SEEK_TIMEOUT_MS = 15_000;
/**
 * Opening a file is not seeking within it, and on a multi-gigabyte recording it is much
 * slower — especially with the audio pass competing for the same disk.
 */
const OPEN_TIMEOUT_MS = 60_000;
/** Consecutive failures that mean the media is gone rather than merely slow. */
const MAX_CONSECUTIVE_FAILURES = 4;
/** Motion is a coarse question; 32x32 answers it and costs a kilobyte a frame. */
const LUMA_SIZE = 32;

interface Extraction {
  strip: Filmstrip;
  done: Promise<Filmstrip>;
  listeners: Set<(strip: Filmstrip) => void>;
}

const cache = new Map<string, Extraction>();

/**
 * Extract a source's filmstrip, once.
 *
 * Promise-cached rather than hook-local so the signals pass can await the same extraction
 * the timeline is already running, instead of seeking through the recording a second time.
 * Progress is pushed to listeners as frames arrive: a timeline with half a filmstrip is
 * useful, one that blocks until all of it is ready is not.
 *
 * Two passes over one open `<video>`. The first takes the thumbnails, and the strip is
 * announced ready at the end of it, because that is the pass someone is waiting on. The
 * second fills in the motion samples between them — seven times as many seeks, all of them
 * after the editor is already usable, and nothing on screen depends on them finishing.
 */
export function loadFilmstrip(
  sourceId: string,
  objectUrl: string,
  durationUs: number,
  onProgress?: (strip: Filmstrip) => void,
): Promise<Filmstrip> {
  let entry = cache.get(sourceId);

  if (!entry) {
    const frames: Frame[] = [];
    const luma: LumaSample[] = [];
    const created: Extraction = { strip: EMPTY, done: Promise.resolve(EMPTY), listeners: new Set() };

    const publish = (strip: Filmstrip) => {
      created.strip = strip;
      for (const listener of created.listeners) listener(strip);
    };
    const snapshot = (aspect: number, ready: boolean, motionReady: boolean): Filmstrip => ({
      frames: [...frames],
      // Sorted on the way out rather than on the way in: the second pass fills the gaps
      // the first one left, so the arrival order is not time order, and `analyzeMotion`
      // differences consecutive entries.
      luma: [...luma].sort((a, b) => a.t - b.t),
      ready,
      motionReady,
      aspect,
    });

    created.done = extractFrames(objectUrl, durationUs, {
      onFrame(frame, sample, aspect) {
        frames.push(frame);
        luma.push(sample);
        publish(snapshot(aspect, false, false));
      },
      onThumbnailsDone(aspect) {
        publish(snapshot(aspect, true, false));
      },
      onLuma(sample, aspect) {
        luma.push(sample);
        publish(snapshot(aspect, true, false));
      },
    })
      .then((aspect) => {
        const strip = snapshot(aspect, true, true);
        publish(strip);
        return strip;
      })
      .catch(() => {
        // A strip that stops early is still useful; a thrown error would take the editor
        // down over decorative pixels. Whatever arrived is what there is.
        const strip = { ...created.strip, ready: true, motionReady: true };
        publish(strip);
        return strip;
      });

    entry = created;
    cache.set(sourceId, entry);
  }

  if (onProgress) {
    const listeners = entry.listeners;
    const listener = onProgress;
    listeners.add(listener);
    onProgress(entry.strip);
    void entry.done.finally(() => listeners.delete(listener));
  }

  return entry.done;
}

export function useFilmstrip(sourceId: string | null, objectUrl: string | null, durationUs: number): Filmstrip {
  const [strip, setStrip] = useState<Filmstrip>(() => (sourceId && cache.get(sourceId)?.strip) || EMPTY);

  useEffect(() => {
    if (!sourceId || !objectUrl || durationUs <= 0) return;

    let live = true;
    void loadFilmstrip(sourceId, objectUrl, durationUs, (next) => {
      if (live) setStrip(next);
    });

    return () => {
      live = false;
    };
  }, [sourceId, objectUrl, durationUs]);

  return strip;
}

/** The frame to show for a given source time — the last one at or before it. */
export function frameAt(strip: Filmstrip, sourceTimeUs: number): Frame | null {
  if (strip.frames.length === 0) return null;
  let best = strip.frames[0]!;
  for (const frame of strip.frames) {
    if (frame.t <= sourceTimeUs) best = frame;
    else break;
  }
  return best;
}

interface ExtractHandlers {
  onFrame(frame: Frame, sample: LumaSample, aspect: number): void;
  onThumbnailsDone(aspect: number): void;
  onLuma(sample: LumaSample, aspect: number): void;
}

/** The times to seek to, split into the pass that is watched and the pass that is not. */
export function planExtraction(durationUs: number): { thumbnails: number[]; luma: number[] } {
  const thumbnailInterval = Math.max(MIN_INTERVAL_US, Math.ceil(durationUs / MAX_FRAMES));
  const lumaInterval = Math.min(
    thumbnailInterval,
    Math.max(MIN_LUMA_INTERVAL_US, Math.ceil(durationUs / MAX_LUMA_SAMPLES)),
  );

  const thumbnails: number[] = [];
  for (let t = 0; t < durationUs; t += thumbnailInterval) thumbnails.push(t);

  // Only the times the first pass will not already have visited. Seeking twice to the
  // same frame would cost as much as the seek that produced it.
  const taken = new Set(thumbnails);
  const luma: number[] = [];
  for (let t = 0; t < durationUs; t += lumaInterval) if (!taken.has(t)) luma.push(t);

  return { thumbnails, luma };
}

async function extractFrames(
  objectUrl: string,
  durationUs: number,
  handlers: ExtractHandlers,
): Promise<number> {
  const plan = planExtraction(durationUs);
  const video = document.createElement('video');
  video.src = objectUrl;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  // Some iOS versions refuse to decode for a detached element, so it goes in the
  // document — just far enough off-screen to be invisible and un-tappable.
  video.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.appendChild(video);

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  // A second, tiny surface for the motion signal. Drawing the same frame twice is far
  // cheaper than reading back a full-size bitmap and downsampling it here.
  const small = document.createElement('canvas');
  small.width = LUMA_SIZE;
  small.height = LUMA_SIZE;
  const smallContext = small.getContext('2d', { willReadFrequently: true });

  try {
    await once(video, 'loadeddata', OPEN_TIMEOUT_MS);
    if (!context || !video.videoWidth) return 9 / 16;

    const aspect = video.videoWidth / video.videoHeight;
    canvas.height = FRAME_HEIGHT;
    canvas.width = Math.max(1, Math.round(FRAME_HEIGHT * aspect));

    const sampleLuma = (t: number): LumaSample => {
      smallContext?.drawImage(video, 0, 0, LUMA_SIZE, LUMA_SIZE);
      const pixels = smallContext?.getImageData(0, 0, LUMA_SIZE, LUMA_SIZE).data;
      return {
        t,
        width: LUMA_SIZE,
        height: LUMA_SIZE,
        luma: pixels ? lumaFromRgba(pixels, LUMA_SIZE, LUMA_SIZE) : new Uint8Array(0),
      };
    };

    // A failed seek costs its own frame and nothing else. Aborting the pass on the first
    // one is what emptied the motion signal on a large recording, and a strip with a gap
    // in it is worth far more than no strip at all.
    let consecutive = 0;
    const seek = async (t: number): Promise<boolean> => {
      video.currentTime = t / 1_000_000;
      try {
        await once(video, 'seeked', SEEK_TIMEOUT_MS);
        consecutive = 0;
        return true;
      } catch {
        consecutive += 1;
        return false;
      }
    };

    for (const t of plan.thumbnails) {
      if (consecutive >= MAX_CONSECUTIVE_FAILURES) break;
      if (!(await seek(t))) continue;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      handlers.onFrame({ t, url: canvas.toDataURL('image/jpeg', 0.6) }, sampleLuma(t), aspect);
    }
    handlers.onThumbnailsDone(aspect);

    // From here on nothing on screen is waiting.
    for (const t of plan.luma) {
      if (consecutive >= MAX_CONSECUTIVE_FAILURES) break;
      if (await seek(t)) handlers.onLuma(sampleLuma(t), aspect);
    }

    return aspect;
  } finally {
    video.removeAttribute('src');
    video.load();
    video.remove();
  }
}

function once(target: HTMLVideoElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);

    const onDone = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`Media error while waiting for ${event}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(event, onDone);
      target.removeEventListener('error', onError);
    };

    target.addEventListener(event, onDone, { once: true });
    target.addEventListener('error', onError, { once: true });
  });
}
