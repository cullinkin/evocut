import { FPS_30, newId, secondsToMicros, type Rational, type Source } from '@evocut/edl';
import { readVideoFrameRate } from '@evocut/renderer';
import type { MediaRecord } from '@evocut/store';

/**
 * Read what we can about a video file without decoding it.
 *
 * A `<video>` element gives duration and display dimensions and nothing else — notably not
 * the frame rate. That was tolerable while the rate was only a nominal figure in the EDL:
 * cut points are stored in microseconds and snapped to frames at render time, so a wrong
 * nominal rate could not corrupt an edit. It stopped being tolerable when the timeline ruler
 * started counting frames — a mark labelled `15f` half a second into a 60fps recording is a
 * lie, and it is a lie the user aims a cut at.
 *
 * So the rate comes from the container's own sample table, read out of `moov` with the same
 * parser the audio comes through: a few hundred kilobytes, no decode. Anything that parser
 * cannot read — WebM, fragmented MP4 — falls back to nominal 30, exactly as before.
 */
export interface VideoMetadata {
  durationUs: number;
  width: number;
  height: number;
  frameRate: Rational;
  /** True when the container's frame durations vary, so `frameRate` is the commonest one. */
  variableFrameRate: boolean;
}

export async function probeVideo(file: File): Promise<VideoMetadata> {
  const shape = await readShape(file);

  // Best-effort by design. A file whose rate cannot be read is still perfectly editable;
  // its ruler just counts thirty frames to the second like every other editor's default.
  const rate = await readVideoFrameRate(file).catch(() => null);
  return {
    ...shape,
    frameRate: rate?.frameRate ?? FPS_30,
    variableFrameRate: rate?.variable ?? false,
  };
}

type VideoShape = Pick<VideoMetadata, 'durationUs' | 'width' | 'height'>;

function readShape(file: File): Promise<VideoShape> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;

    const done = <T,>(finish: (value: T) => void, value: T) => {
      URL.revokeObjectURL(objectUrl);
      finish(value);
    };

    video.onerror = () => {
      // The type matters enough to name it: an empty one is the usual cause on Safari,
      // which — unlike Chromium — will not sniff a container out of an untyped blob.
      const kind = file.type || 'unknown type';
      done(
        reject,
        new Error(`Could not read ${file.name} (${kind}). It may be a format this browser cannot decode.`),
      );
    };

    video.onloadedmetadata = () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        // Some Android captures report Infinity until the file is fully buffered.
        done(reject, new Error(`Could not determine the length of ${file.name}.`));
        return;
      }
      done(resolve, {
        durationUs: secondsToMicros(video.duration),
        width: video.videoWidth,
        height: video.videoHeight,
      });
    };

    video.src = objectUrl;
  });
}

/**
 * Build a `Source` for media that is already in the store.
 *
 * The locator is `opfs` from the outset — the app never persists a project whose media it
 * has not saved first, so the `unresolved` variant only ever appears for a project whose
 * bytes went missing after the fact.
 */
export function sourceFromMedia(record: MediaRecord, meta: VideoMetadata): Source {
  return {
    id: newId('source'),
    locator: { kind: 'opfs', path: record.path },
    name: record.filename,
    duration: meta.durationUs,
    video: {
      width: meta.width,
      height: meta.height,
      frameRate: meta.frameRate,
      rotation: 0,
      variableFrameRate: meta.variableFrameRate,
    },
    ...(record.mimeType ? { mimeType: record.mimeType } : {}),
    sizeBytes: record.sizeBytes,
    contentHash: record.fingerprint,
    importedAt: record.importedAt,
  };
}
