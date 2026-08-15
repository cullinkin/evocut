/**
 * `@evocut/signals` — the refinement pass's only perception.
 *
 * Everything else in EvoCut works on the *edit*: where the cuts are, what the clips are,
 * what the ops did. Nothing until now looked at the footage. This package measures three
 * things about a recording — how loud it is, where it spikes, and whether the picture is
 * moving — and rewrites them in the clock the model has to answer in.
 *
 * It is pure and dependency-free by design. Decoding audio and grabbing frames belongs to
 * whatever environment has a browser in it; the analysis is arithmetic, and arithmetic
 * should be testable without one.
 */

export * from './types.js';
export * from './audio.js';
export * from './motion.js';
export * from './summarize.js';
