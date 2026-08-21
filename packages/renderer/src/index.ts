/**
 * `@evocut/renderer` — EvoCut's own output path.
 *
 * ## Why our own renderer
 *
 * The refinement pass emits sub-frame trims, speed changes, and animated framing. Handing
 * that to a general-purpose editor means round-tripping through its project format and
 * losing exactly the precision the LLM is being asked to supply. Encoding and packaging
 * ourselves also keeps the whole flow inside the browser, so a phone never has to upload
 * the footage to get a result back.
 *
 * ## The pieces
 *
 * - `sample.ts` — pure: what is on screen at output time `t`. The preview and the export
 *   both call it, which is what stops them disagreeing at a cut.
 * - `compose.ts` — pure: where a decoded frame lands inside the output frame.
 * - `audio.ts` — the mixdown: which clip is audible when, and at what gain.
 * - `demux.ts` — where the audio lives inside an MP4, read without reading the MP4.
 * - `decode-audio.ts` — that audio turned into samples, a slice at a time.
 * - `mp4.ts` — the container. WebCodecs encodes but does not package.
 * - `render.ts` — the pipeline that drives them all.
 */

export * from './sample.js';
export * from './compose.js';
export * from './color.js';
export * from './audio.js';
export * from './demux.js';
export * from './decode-audio.js';
export * from './mp4.js';
export * from './encode.js';
export * from './proxy.js';
export * from './render.js';
