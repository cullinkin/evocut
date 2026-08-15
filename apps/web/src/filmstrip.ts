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
  /**
   * The same frame reduced to a tiny greyscale bitmap, for the motion signal.
   *
   * Carried here rather than gathered in a pass of its own because the expensive part of
   * "look at every second of this recording" is the seeking, and this pass is already
   * doing it. A second loop over the whole take, on a phone, to answer "is this shot
   * static" would cost minutes for a yes-or-no.
   */
  luma: Uint8Array;
  lumaWidth: number;
  lumaHeight: number;
}

export interface Filmstrip {
  frames: Frame[];
  ready: boolean;
  /** Aspect ratio of the extracted frames, for laying out the strip. */
  aspect: number;
}

const EMPTY: Filmstrip = { frames: [], ready: false, aspect: 9 / 16 };

/** Cap on frames per source: enough to read a 10-minute take, cheap enough for a phone. */
const MAX_FRAMES = 80;
const MIN_INTERVAL_US = 1_000_000;
/**
 * Frames are captured well above their display size.
 *
 * The lane is 64 CSS px tall on a 3x screen, so a slot is ~190 device pixels wide. Phone
 * footage is portrait, so a frame captured at 56px tall is only ~31px wide — upscaled six
 * times on an iPhone, which is what made the strip look like smeared paint rather than
 * video. 144 gives ~81px for 9:16 and reads as an actual picture.
 */
const FRAME_HEIGHT = 144;
const SEEK_TIMEOUT_MS = 4000;
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
 */
export function loadFilmstrip(
  sourceId: string,
  objectUrl: string,
  durationUs: number,
  onProgress?: (strip: Filmstrip) => void,
): Promise<Filmstrip> {
  let entry = cache.get(sourceId);

  if (!entry) {
    const collected: Frame[] = [];
    const created: Extraction = { strip: EMPTY, done: Promise.resolve(EMPTY), listeners: new Set() };

    const publish = (strip: Filmstrip) => {
      created.strip = strip;
      for (const listener of created.listeners) listener(strip);
    };

    created.done = extractFrames(objectUrl, durationUs, (frame, aspect) => {
      collected.push(frame);
      publish({ frames: [...collected], ready: false, aspect });
      return true;
    })
      .then((aspect) => {
        const strip = { frames: collected, ready: true, aspect };
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

async function extractFrames(
  objectUrl: string,
  durationUs: number,
  emit: (frame: Frame, aspect: number) => boolean,
): Promise<number> {
  const interval = Math.max(MIN_INTERVAL_US, Math.ceil(durationUs / MAX_FRAMES));
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
    await once(video, 'loadeddata', SEEK_TIMEOUT_MS);
    if (!context || !video.videoWidth) return 9 / 16;

    const aspect = video.videoWidth / video.videoHeight;
    canvas.height = FRAME_HEIGHT;
    canvas.width = Math.max(1, Math.round(FRAME_HEIGHT * aspect));

    for (let t = 0; t < durationUs; t += interval) {
      video.currentTime = t / 1_000_000;
      await once(video, 'seeked', SEEK_TIMEOUT_MS);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      smallContext?.drawImage(video, 0, 0, LUMA_SIZE, LUMA_SIZE);
      const pixels = smallContext?.getImageData(0, 0, LUMA_SIZE, LUMA_SIZE).data;

      const frame: Frame = {
        t,
        url: canvas.toDataURL('image/jpeg', 0.6),
        luma: pixels ? lumaFromRgba(pixels, LUMA_SIZE, LUMA_SIZE) : new Uint8Array(0),
        lumaWidth: LUMA_SIZE,
        lumaHeight: LUMA_SIZE,
      };
      if (!emit(frame, aspect)) break;
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
