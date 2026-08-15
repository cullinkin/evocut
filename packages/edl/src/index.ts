/**
 * `@evocut/edl` — the edit decision list.
 *
 * Everything else in EvoCut is downstream of this package: the mobile coarse-cut UI
 * produces an EDL, the LLM refinement pass emits ops against it, the renderer consumes it,
 * and the training export reads its log. It has no dependencies beyond zod and runs
 * unchanged in a browser, a worker, and Node.
 *
 * Start with `docs/edl-spec.md` for the model, or `factory.ts` for the entry points.
 */

export * from './schema/index.js';
export * from './time.js';
export * from './interpolate.js';
export * from './normalize.js';
export * from './apply.js';
export * from './validate.js';
export * from './factory.js';
export * from './digest.js';
export * from './describe.js';
export * from './review.js';
export * from './jsonschema.js';
