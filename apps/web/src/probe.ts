import { FPS_30, newId, secondsToMicros, type Source } from '@evocut/edl';

/**
 * Read what we can about a picked file without decoding it.
 *
 * A `<video>` element gives duration and display dimensions and nothing else — notably
 * not the frame rate, which is why `Source.video.frameRate` is nominal until the renderer
 * opens the file properly. That is fine for the coarse pass: cut points are stored in
 * microseconds and only get snapped to frames at render time, so a wrong nominal rate here
 * cannot corrupt the EDL.
 */
export interface ProbedFile {
  source: Source;
  /** Object URL for playback. The caller owns revoking it. */
  objectUrl: string;
}

export function probeVideoFile(file: File): Promise<ProbedFile> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;

    const fail = (reason: string) => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error(reason));
    };

    video.onerror = () => fail(`Could not read ${file.name}. It may be a format this browser cannot decode.`);

    video.onloadedmetadata = () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        // Some Android captures report Infinity until the file is fully buffered.
        fail(`Could not determine the length of ${file.name}.`);
        return;
      }

      resolve({
        objectUrl,
        source: {
          id: newId('source'),
          // The blob URL dies with the page, so the EDL records only what the user picked.
          // Reopening a project has to ask for the file again until media is persisted.
          locator: { kind: 'unresolved', filename: file.name },
          name: file.name,
          duration: secondsToMicros(video.duration),
          video: {
            width: video.videoWidth,
            height: video.videoHeight,
            frameRate: FPS_30,
            rotation: 0,
            variableFrameRate: false,
          },
          mimeType: file.type || undefined,
          sizeBytes: file.size,
          importedAt: new Date().toISOString(),
        },
      });
    };

    video.src = objectUrl;
  });
}
