import { z } from 'zod';
import { NonNegativeMicrosSchema, RationalSchema, SourceId, Timestamp } from './common.js';

/**
 * Where the bytes actually live.
 *
 * On mobile web the same recording can be an OPFS file, a `blob:` URL from a file input,
 * or an uploaded object — and it changes identity between sessions (a `blob:` URL does not
 * survive a reload). So the EDL stores a stable `id` plus a *locator hint*, and the app is
 * responsible for re-binding the hint to real bytes on load.
 */
export const SourceLocator = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('opfs'),
    /** Path within the origin-private file system. */
    path: z.string().min(1),
  }),
  z.object({
    kind: z.literal('url'),
    url: z.string().url(),
  }),
  z.object({
    kind: z.literal('object'),
    /** Key in remote object storage, once a project is synced. */
    bucket: z.string().min(1),
    key: z.string().min(1),
  }),
  z.object({
    kind: z.literal('unresolved'),
    /** All we know is what the user picked. Prompt them to re-select on load. */
    filename: z.string().min(1),
  }),
]);
export type SourceLocator = z.infer<typeof SourceLocator>;

export const VideoStreamInfo = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  frameRate: RationalSchema,
  /** Rotation the container asks us to apply on display. Phones set this constantly. */
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
  /** WebCodecs codec string, e.g. `avc1.640028`. */
  codec: z.string().optional(),
  /** True when the container reports variable frame rate; `frameRate` is then nominal. */
  variableFrameRate: z.boolean().default(false),
});
export type VideoStreamInfo = z.infer<typeof VideoStreamInfo>;

export const AudioStreamInfo = z.object({
  sampleRate: z.number().int().positive(),
  channels: z.number().int().positive().max(32),
  codec: z.string().optional(),
});
export type AudioStreamInfo = z.infer<typeof AudioStreamInfo>;

/** An immutable piece of media the timeline can reference. Sources are never edited. */
export const Source = z.object({
  id: SourceId,
  locator: SourceLocator,
  /** Display name. Falls back to the original filename. */
  name: z.string().max(500).optional(),
  /** Full duration of the media, independent of what the timeline uses. */
  duration: NonNegativeMicrosSchema,
  video: VideoStreamInfo.optional(),
  audio: AudioStreamInfo.optional(),
  /** Container MIME type, e.g. `video/mp4`. */
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  /** Content hash, when we have one. Lets us re-bind media across devices. */
  contentHash: z.string().optional(),
  importedAt: Timestamp.optional(),
});
export type Source = z.infer<typeof Source>;
