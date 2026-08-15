import { useEffect, useState } from 'react';

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
const FRAME_HEIGHT = 56;
const SEEK_TIMEOUT_MS = 4000;

const cache = new Map<string, Filmstrip>();

export function useFilmstrip(sourceId: string | null, objectUrl: string | null, durationUs: number): Filmstrip {
  const [strip, setStrip] = useState<Filmstrip>(() => (sourceId && cache.get(sourceId)) || EMPTY);

  useEffect(() => {
    if (!sourceId || !objectUrl || durationUs <= 0) return;

    const cached = cache.get(sourceId);
    if (cached?.ready) {
      setStrip(cached);
      return;
    }

    let cancelled = false;
    const collected: Frame[] = [];

    void extractFrames(objectUrl, durationUs, (frame, aspect) => {
      if (cancelled) return false;
      collected.push(frame);
      const next = { frames: [...collected], ready: false, aspect };
      cache.set(sourceId, next);
      setStrip(next);
      return true;
    })
      .then((aspect) => {
        if (cancelled) return;
        const done = { frames: collected, ready: true, aspect };
        cache.set(sourceId, done);
        setStrip(done);
      })
      .catch(() => {
        // A strip that stops early is still useful; a thrown error would take the
        // editor down over decorative pixels.
        if (cancelled) return;
        setStrip((previous) => ({ ...previous, ready: true }));
      });

    return () => {
      cancelled = true;
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
      if (!emit({ t, url: canvas.toDataURL('image/jpeg', 0.55) }, aspect)) break;
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
