import { FPS_30, newId, secondsToMicros, type Source } from '@evocut/edl';
import type { MediaRecord } from '@evocut/store';

/**
 * Read what we can about a video file without decoding it.
 *
 * A `<video>` element gives duration and display dimensions and nothing else — notably not
 * the frame rate, which is why `Source.video.frameRate` stays nominal until the renderer
 * opens the file properly. That is fine for the coarse pass: cut points are stored in
 * microseconds and only snapped to frames at render time, so a wrong nominal rate here
 * cannot corrupt the EDL.
 */
export interface VideoMetadata {
  durationUs: number;
  width: number;
  height: number;
}

export function probeVideo(file: File): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;

    const done = <T>(finish: (value: T) => void, value: T) => {
      URL.revokeObjectURL(objectUrl);
      finish(value);
    };

    video.onerror = () =>
      done(reject, new Error(`Could not read ${file.name}. It may be a format this browser cannot decode.`));

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
      frameRate: FPS_30,
      rotation: 0,
      variableFrameRate: false,
    },
    ...(record.mimeType ? { mimeType: record.mimeType } : {}),
    sizeBytes: record.sizeBytes,
    contentHash: record.fingerprint,
    importedAt: record.importedAt,
  };
}
