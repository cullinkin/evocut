import { useEffect, useState } from 'react';
import { whenQuiet } from './quiet.ts';
import { noteStage } from './recover.ts';
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
  /** The thumbnails are complete — and with them, the luma this strip will ever have. */
  ready: boolean;
  /** Aspect ratio of the extracted frames, for laying out the strip. */
  aspect: number;
}

const EMPTY: Filmstrip = { frames: [], luma: [], ready: false, aspect: 9 / 16 };

/** Cap on thumbnails per source: enough to read a take at a glance, cheap on a phone. */
const MAX_FRAMES = 80;
const MIN_INTERVAL_US = 1_000_000;

/*
  Motion no longer has a sampling budget here, and the frames this pass takes are the only
  ones it gets.

  It used to have one: six hundred extra seeks, on the reasoning that eighty frames across
  a 27-minute recording is one every twenty seconds and two frames that far apart are
  unrelated pictures. The reasoning was right and the remedy was wrong. Six hundred seeks
  through a multi-gigabyte HEVC file, each followed by a main-thread `drawImage` of a 4K
  frame, is minutes of stolen main thread — measured off a screen recording of a real
  session as whole seconds where the interface did not move at all.

  So the budget is gone and the luma of the thumbnails — which this pass takes anyway — is
  all the motion signal gets. That is coarser than it was, and it is the right trade: the
  signal answers "is this shot locked off" for a model deciding whether to suggest a push-in,
  and no answer to that is worth minutes of a frozen editor. A finer measurement is coming
  from the container's own index, which costs no seeks at all.
*/
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

/*
  Whether the strip may be extracted at all.

  Off in recovery — see `recover.ts`. Extraction opens a third `<video>` on a
  multi-gigabyte recording and seeks it eighty times, which is exactly the sort of work
  that gets a tab killed on a phone, and a session that is trying to survive should not be
  spending its allowance on decoration.
*/
let extracting = true;

export function setFilmstripExtraction(on: boolean): void {
  extracting = on;
}

/**
 * Extract a source's filmstrip, once.
 *
 * Promise-cached rather than hook-local so the signals pass can await the same extraction
 * the timeline is already running, instead of seeking through the recording a second time.
 * Progress is pushed to listeners as frames arrive: a timeline with half a filmstrip is
 * useful, one that blocks until all of it is ready is not.
 *
 * One pass over one open `<video>`, waiting for a gap in what the user is doing before
 * each seek. There used to be a second pass taking seven times as many samples for the
 * motion signal; the container's own sample table answers that question per frame and for
 * free, and the pass was costing whole seconds of frozen interface. See `quiet.ts`.
 */
export function loadFilmstrip(
  sourceId: string,
  objectUrl: string,
  durationUs: number,
  onProgress?: (strip: Filmstrip) => void,
): Promise<Filmstrip> {
  if (!extracting) {
    onProgress?.(EMPTY);
    return Promise.resolve(EMPTY);
  }

  let entry = cache.get(sourceId);

  if (!entry) {
    const frames: Frame[] = [];
    const luma: LumaSample[] = [];
    const created: Extraction = { strip: EMPTY, done: Promise.resolve(EMPTY), listeners: new Set() };

    const publish = (strip: Filmstrip) => {
      created.strip = strip;
      for (const listener of created.listeners) listener(strip);
    };
    const snapshot = (aspect: number, ready: boolean): Filmstrip => ({
      frames: [...frames],
      // Sorted on the way out rather than on the way in: a seek that fails leaves a gap,
      // and `analyzeMotion` differences consecutive entries.
      luma: [...luma].sort((a, b) => a.t - b.t),
      ready,
      aspect,
    });

    created.done = extractFrames(objectUrl, durationUs, {
      onFrame(frame, sample, aspect) {
        frames.push(frame);
        luma.push(sample);
        publish(snapshot(aspect, false));
      },
      onThumbnailsDone(aspect) {
        publish(snapshot(aspect, true));
      },
    })
      .then((aspect) => {
        const strip = snapshot(aspect, true);
        publish(strip);
        return strip;
      })
      .catch(() => {
        // A strip that stops early is still useful; a thrown error would take the editor
        // down over decorative pixels. Whatever arrived is what there is.
        const strip = { ...created.strip, ready: true };
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

/**
 * Every source's strip at once, from one subscription.
 *
 * `useFilmstrip` was called inside each clip block, which on a fifty-one clip timeline is
 * fifty-one subscriptions to the same strip and fifty-one pieces of component state that
 * all change together. It also meant a clip block could not be memoised — it held a hook
 * whose value changed underneath it — so *every* one of them re-rendered on every playhead
 * change, sixty times a second during a scroll, each rebuilding its row of thumbnails.
 * That is the freeze.
 *
 * One subscription, one Map, and the blocks become pure functions of their props.
 */
export function useFilmstrips(
  sources: Array<{ id: string; url: string | null; durationUs: number }>,
): Map<string, Filmstrip> {
  const [strips, setStrips] = useState<Map<string, Filmstrip>>(new Map());

  // The effect must not re-run because an array literal was rebuilt; what it depends on is
  // which sources exist and where their bytes are.
  const identity = sources.map((source) => `${source.id}:${source.url}:${source.durationUs}`).join('|');

  useEffect(() => {
    let live = true;
    const ready = new Map<string, Filmstrip>();

    for (const source of sources) {
      if (!source.url || source.durationUs <= 0) continue;
      void loadFilmstrip(source.id, source.url, source.durationUs, (next) => {
        if (!live) return;
        ready.set(source.id, next);
        // A new Map each time, because React compares by identity — but only one, rather
        // than one per clip.
        setStrips(new Map(ready));
      });
    }

    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  return strips;
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

/**
 * How far apart this strip's frames actually are.
 *
 * Not a constant, and that turns out to matter a great deal. `planExtraction` divides the
 * source into at most `MAX_FRAMES`, so a twelve-second clip gets a frame a second and a
 * twenty-seven-minute recording gets one every twenty seconds. Anything that treats a
 * filmstrip frame as "roughly what is on screen right now" has to know which of those it
 * is holding.
 */
export function frameSpacingUs(strip: Filmstrip): number {
  if (strip.frames.length < 2) return Number.POSITIVE_INFINITY;
  return strip.frames[1]!.t - strip.frames[0]!.t;
}

/**
 * How many thumbnails to draw across a clip.
 *
 * ## The bug this is
 *
 * It used to be one per 56 pixels of block, with nothing bounding it. That is fine at the
 * zoom the editor originally had. It is ruinous at the zoom it has now: a thirty-second
 * clip at full zoom is thirty-five thousand pixels wide, which is *six hundred* `<img>`
 * elements for one clip, and a fifty-clip timeline is tens of thousands of DOM nodes built
 * on a phone. Reported as "extraordinarily slow and laggy, especially when zoomed in",
 * which is exactly where the number explodes.
 *
 * ## Two ceilings, and the interesting one is the second
 *
 * The first is a flat cap, so no single block can ever be unbounded.
 *
 * The second is the honest one: **there is no point drawing more thumbnails than the
 * filmstrip has frames for that stretch of recording.** The strip holds at most eighty
 * frames for a whole source, so on a twenty-seven minute master they are twenty seconds
 * apart — and a thirty-second clip has two of them, whatever its width. The old code drew
 * six hundred copies of those two pictures. Asking for what exists rather than for what
 * would fit is both faster and more truthful: the strip stops pretending to a detail it
 * does not have.
 */
export const MAX_THUMBNAILS_PER_CLIP = 40;

export function thumbnailSlots(widthPx: number, spanUs: number, spacingUs: number): number {
  const byWidth = Math.round(widthPx / 56);
  const available = Number.isFinite(spacingUs) && spacingUs > 0 ? Math.ceil(spanUs / spacingUs) : byWidth;
  return Math.max(1, Math.min(byWidth, available, MAX_THUMBNAILS_PER_CLIP));
}

/**
 * A frame close enough to `sourceTimeUs` to stand in for it, or null.
 *
 * The distinction `frameAt` does not make, and the reason the scrub preview was reported as
 * "the picture just gets all grainy until the next clip is hit". On a twenty-seven minute
 * source the nearest filmstrip frame can be twenty seconds away from where the thumb is:
 * it is not a preview of that moment, it is a picture of somewhere else entirely, and
 * holding it over the video while the real frame is on its way is worse than showing
 * nothing. Better a stale sharp frame you can recognise than a wrong blurry one.
 */
export function frameNear(strip: Filmstrip, sourceTimeUs: number, withinUs: number): Frame | null {
  const frame = frameAt(strip, sourceTimeUs);
  if (!frame) return null;
  return Math.abs(frame.t - sourceTimeUs) <= withinUs ? frame : null;
}

interface ExtractHandlers {
  onFrame(frame: Frame, sample: LumaSample, aspect: number): void;
  onThumbnailsDone(aspect: number): void;
}

/** The times to seek to, split into the pass that is watched and the pass that is not. */
export function planExtraction(durationUs: number): { thumbnails: number[] } {
  const thumbnailInterval = Math.max(MIN_INTERVAL_US, Math.ceil(durationUs / MAX_FRAMES));
  const thumbnails: number[] = [];
  for (let t = 0; t < durationUs; t += thumbnailInterval) thumbnails.push(t);
  return { thumbnails };
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
    // Opening a multi-gigabyte recording on a third `<video>` is real work, and until now
    // it happened under the previous stage's name — which is how four crash reports came
    // back saying only "editor". See `recover.ts`.
    noteStage('measure:open');
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
      // Between frames, not during one: a seek and the draw that follows it are a few
      // hundred milliseconds of main thread on a phone, and taking them while someone is
      // scrubbing is what made the whole interface stop. See `quiet.ts`.
      await whenQuiet();
      noteStage('measure:frames');
      if (!(await seek(t))) continue;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      handlers.onFrame({ t, url: canvas.toDataURL('image/jpeg', 0.6) }, sampleLuma(t), aspect);
    }
    handlers.onThumbnailsDone(aspect);

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
