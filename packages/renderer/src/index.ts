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
 * - `mp4.ts` — the container. WebCodecs encodes but does not package.
 * - `render.ts` — the pipeline that drives all four.
 */

export * from './sample.js';
export * from './compose.js';
export * from './audio.js';
export * from './mp4.js';
export * from './render.js';
