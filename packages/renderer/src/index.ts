import type { Project, Timeline } from '@evocut/edl';

/**
 * `@evocut/renderer` — EvoCut's own output path.
 *
 * ## Status
 *
 * Implemented: the sampling core (`sample.ts`) — pure, tested, and the single source of
 * truth for "what is on screen at time t". Both the preview and the export use it.
 *
 * Not yet implemented: the WebCodecs pipeline below. The interfaces are here because they
 * are the contract the sampling core was designed against, and because pinning them now is
 * what keeps the EDL honest — every field the renderer will need has to already exist in
 * the schema.
 *
 * ## Why our own renderer
 *
 * The refinement pass emits sub-frame trims, speed changes, and animated framing. Handing
 * that to a general-purpose editor means round-tripping through its project format and
 * losing exactly the precision the LLM is being asked to supply. Decoding and encoding
 * ourselves also keeps the whole flow inside the browser, so a phone never has to upload
 * the footage to get a result.
 */

export * from './sample.js';

/** Resolves a source id to decodable bytes. Implemented by the app, not the renderer. */
export interface MediaResolver {
  open(sourceId: string): Promise<ReadableStream<Uint8Array> | Blob>;
}

export interface RenderRequest {
  project: Project;
  /** Defaults to `project.timeline`. Pass a snapshot to render an earlier revision. */
  timeline?: Timeline;
  resolver: MediaResolver;
  signal?: AbortSignal;
}

export interface RenderProgress {
  /** 0..1 over the whole export. */
  progress: number;
  framesEncoded: number;
  framesTotal: number;
  stage: 'preparing' | 'encoding' | 'muxing' | 'done';
}

export interface RenderResult {
  blob: Blob;
  durationUs: number;
  framesEncoded: number;
}

export interface Renderer {
  render(request: RenderRequest, onProgress?: (p: RenderProgress) => void): Promise<RenderResult>;
}

/** True when the browser has the codec APIs the renderer needs. */
export function isRenderSupported(): boolean {
  return (
    typeof globalThis.VideoEncoder === 'function' &&
    typeof globalThis.VideoDecoder === 'function' &&
    typeof globalThis.VideoFrame === 'function'
  );
}
