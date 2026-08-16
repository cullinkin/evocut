import type { Clip, Timeline } from '@evocut/edl';
import type { ClipFrames } from '@evocut/agent';

/**
 * Frames from the edit, for the refinement pass to look at.
 *
 * ## Why this exists
 *
 * The pass was editing a spreadsheet. It knew every clip's length and where a transient
 * landed, and nothing about what was in the shot — and it said so, in its own summary on a
 * real session: "no level, quiet or hit data was returned for the long middle clips, so I
 * left their interiors alone rather than guess." A person asked to cut nine minutes to two
 * and a half from a list of durations would produce what it produced.
 *
 * Frames change the question it is being asked. "These four clips are the same pack being
 * opened, keep the sharpest" is an edit; it needs eyes, and this is the eyes.
 *
 * ## Not the filmstrip
 *
 * The timeline's filmstrip samples the *source* on a fixed budget — eighty frames across
 * however long the recording is, which on twenty-seven minutes is one every twenty seconds.
 * Most clips here are under two seconds, so most of them would get no frame at all, and the
 * ones that got one would get a frame from somewhere in the middle of a neighbour. This
 * samples the *clips*, which is a different set of times and a different budget.
 *
 * ## Paying for the seeks
 *
 * Every frame is a seek in a multi-gigabyte file, and on a phone that is most of a second.
 * So: a budget, spent where it buys the most; the frames a clip already gave up are cached
 * for the session, because the second Refine of an evening should be instant; and progress
 * is reported, because two minutes of a silent screen is a hang.
 */

/** Total frames one pass may send. Roughly 120 tokens each — the cost here is the seeking. */
const FRAME_BUDGET = 120;
/** Nothing shorter than this gets a second frame; nothing at all gets more than four. */
const SECOND_FRAME_ABOVE_US = 2_000_000;
const THIRD_FRAME_ABOVE_US = 6_000_000;
const FOURTH_FRAME_ABOVE_US = 20_000_000;

/**
 * Width frames are sent at.
 *
 * Anthropic charges about `w×h/750` tokens, so a 256×455 portrait frame is ~155 tokens and
 * a hundred of them is a rounding error against a 20,000-token prompt. Small enough to be
 * free, large enough to tell one Pokémon card from another — which is the entire job.
 */
const FRAME_WIDTH = 256;
const JPEG_QUALITY = 0.72;

/** How long to wait for one seek before writing that frame off. */
const SEEK_TIMEOUT_MS = 15_000;
const OPEN_TIMEOUT_MS = 60_000;
/** Consecutive failures that mean the file is not going to cooperate, rather than one bad seek. */
const MAX_CONSECUTIVE_FAILURES = 4;

export interface ContactProgress {
  /** Frames captured so far, and how many were planned. */
  done: number;
  total: number;
}

/** Cached per clip range, so re-running a pass does not re-seek the whole recording. */
const cache = new Map<string, Array<{ mediaType: string; data: string }>>();

const keyFor = (clip: Clip, count: number): string =>
  `${clip.sourceId}:${clip.sourceIn}:${clip.sourceOut}:${count}`;

/**
 * How many frames a clip is worth.
 *
 * A half-second clip is one picture; there is no second moment in it. A minute-long clip is
 * the one where "what happens in it" cannot be answered by a single frame, and it is also
 * the one most likely to be cut, so it gets the most.
 */
export function framesFor(durationUs: number): number {
  if (durationUs > FOURTH_FRAME_ABOVE_US) return 4;
  if (durationUs > THIRD_FRAME_ABOVE_US) return 3;
  if (durationUs > SECOND_FRAME_ABOVE_US) return 2;
  return 1;
}

/**
 * Decide how many frames each clip gets, inside the budget.
 *
 * Every clip gets one before any clip gets two — a pass that has seen forty of fifty-one
 * shots is a pass with a hole in it, and the hole will be exactly where it decides nothing
 * happened. Extra frames then go to the longest clips first, which is where a single frame
 * is least representative.
 */
export function planContactSheet(clips: Clip[], budget = FRAME_BUDGET): Map<string, number> {
  const plan = new Map<string, number>();
  if (clips.length === 0) return plan;

  // One each. If there are more clips than budget, the longest ones are the ones to keep:
  // a pass that must choose is better off seeing the shots that dominate the runtime.
  const byLength = [...clips].sort((a, b) => outputLength(b) - outputLength(a));
  let spent = 0;
  for (const clip of byLength) {
    if (spent >= budget) break;
    plan.set(clip.id, 1);
    spent += 1;
  }

  for (let want = 2; want <= 4 && spent < budget; want += 1) {
    for (const clip of byLength) {
      if (spent >= budget) break;
      const has = plan.get(clip.id);
      if (has !== want - 1) continue;
      if (framesFor(outputLength(clip)) < want) continue;
      plan.set(clip.id, want);
      spent += 1;
    }
  }

  return plan;
}

const outputLength = (clip: Clip): number =>
  Math.round((clip.sourceOut - clip.sourceIn) / clip.speed);

/**
 * Capture the contact sheet for a timeline.
 *
 * Returns one entry per clip that yielded at least one frame, in edit order — clips whose
 * seeks all failed are simply absent rather than present and empty, so the model is never
 * shown a label with nothing under it.
 */
export async function captureContactSheet(
  timeline: Timeline,
  objectUrl: string,
  options: { signal?: AbortSignal; onProgress?: (progress: ContactProgress) => void } = {},
): Promise<ClipFrames[]> {
  const clips = timeline.tracks.flatMap((track) => track.clips).filter((clip) => clip.enabled);
  if (clips.length === 0) return [];

  const ordered = [...clips].sort((a, b) => a.start - b.start);
  const plan = planContactSheet(ordered);
  const total = [...plan.values()].reduce((sum, count) => sum + count, 0);

  const out: ClipFrames[] = [];
  let done = 0;
  const report = () => options.onProgress?.({ done, total });
  report();

  // Everything that is already in hand, before opening a video element at all — a second
  // pass over an unchanged edit should cost nothing.
  const pending = ordered.filter((clip) => {
    const count = plan.get(clip.id);
    return count !== undefined && !cache.has(keyFor(clip, count));
  });

  let video: HTMLVideoElement | null = null;
  let canvas: HTMLCanvasElement | null = null;

  try {
    if (pending.length > 0) {
      video = document.createElement('video');
      video.src = objectUrl;
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      await openable(video, options.signal);
      canvas = document.createElement('canvas');
    }

    let failures = 0;
    for (const clip of ordered) {
      const count = plan.get(clip.id);
      if (count === undefined) continue;

      const key = keyFor(clip, count);
      let frames = cache.get(key);

      if (!frames && video && canvas) {
        frames = [];
        for (const at of momentsIn(clip, count)) {
          if (options.signal?.aborted) throw new DOMException('aborted', 'AbortError');
          const frame = await grab(video, canvas, at);
          if (frame) {
            frames.push(frame);
            failures = 0;
          } else if ((failures += 1) >= MAX_CONSECUTIVE_FAILURES) {
            // The file has stopped answering. Whatever has been gathered is what there is;
            // a pass with sixty frames beats no pass at all.
            break;
          }
          done += 1;
          report();
        }
        if (frames.length > 0) cache.set(key, frames);
      }

      if (frames && frames.length > 0) {
        out.push({
          clipId: clip.id,
          index: ordered.indexOf(clip) + 1,
          total: ordered.length,
          startUs: clip.start,
          durationUs: outputLength(clip),
          frames,
        });
      }
    }
  } finally {
    if (video) {
      video.removeAttribute('src');
      video.load();
    }
  }

  done = total;
  report();
  return out;
}

/**
 * Where in the source to sample a clip.
 *
 * Inset from both ends, because the first and last frames of a coarse cut are the parts
 * most likely to be a blur or the edge of a gesture — the exact frames the refinement pass
 * is being asked to trim off. One frame is taken from a third of the way in rather than the
 * middle: a shot usually establishes what it is before it resolves.
 */
export function momentsIn(clip: Clip, count: number): number[] {
  const span = clip.sourceOut - clip.sourceIn;
  const inset = Math.min(span * 0.15, 250_000);
  const from = clip.sourceIn + inset;
  const to = clip.sourceOut - inset;
  if (to <= from) return [Math.round((clip.sourceIn + clip.sourceOut) / 2)];
  if (count <= 1) return [Math.round(from + (to - from) / 3)];
  return Array.from({ length: count }, (_, index) =>
    Math.round(from + ((to - from) * index) / (count - 1)),
  );
}

function openable(video: HTMLVideoElement, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('the video would not open in time')), OPEN_TIMEOUT_MS);
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      video.removeEventListener('loadeddata', ok);
      video.removeEventListener('error', bad);
      error ? reject(error) : resolve();
    };
    const ok = () => finish();
    const bad = () => finish(new Error('the video could not be read'));
    video.addEventListener('loadeddata', ok, { once: true });
    video.addEventListener('error', bad, { once: true });
    signal?.addEventListener('abort', () => finish(new DOMException('aborted', 'AbortError')), { once: true });
    if (video.readyState >= 2) finish();
  });
}

/** One frame, or null if the seek did not land. Never throws for a single bad frame. */
async function grab(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  atUs: number,
): Promise<{ mediaType: string; data: string } | null> {
  try {
    await seek(video, Math.max(0, atUs / 1_000_000));
    if (video.videoWidth === 0) return null;

    const height = Math.max(1, Math.round((FRAME_WIDTH * video.videoHeight) / video.videoWidth));
    canvas.width = FRAME_WIDTH;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, FRAME_WIDTH, height);

    // Split off the `data:image/jpeg;base64,` prefix — the API takes the payload alone.
    const url = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    const comma = url.indexOf(',');
    if (comma < 0) return null;
    return { mediaType: 'image/jpeg', data: url.slice(comma + 1) };
  } catch {
    return null;
  }
}

function seek(video: HTMLVideoElement, seconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('seek timed out')), SEEK_TIMEOUT_MS);
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      video.removeEventListener('seeked', ok);
      error ? reject(error) : resolve();
    };
    const ok = () => finish();
    video.addEventListener('seeked', ok, { once: true });
    video.currentTime = seconds;
  });
}

/** Forget everything cached. Used when the media is relinked or the project closes. */
export function forgetContactSheets(): void {
  cache.clear();
}
