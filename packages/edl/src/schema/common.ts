import { z } from 'zod';

/**
 * Every entity carries a prefixed id (`clp_a1b2…`). The prefix is not decoration: ops
 * coming back from the LLM reference ids by string, and a mistyped `trackId` where a
 * `clipId` belongs is the single most likely model error. The prefix makes it a schema
 * failure instead of a confusing runtime one.
 */
export const ID_PREFIXES = {
  project: 'prj',
  source: 'src',
  timeline: 'tl',
  track: 'trk',
  clip: 'clp',
  effect: 'fx',
  revision: 'rev',
  event: 'evt',
} as const;

export type EntityKind = keyof typeof ID_PREFIXES;

function idSchema<K extends EntityKind>(kind: K) {
  const prefix = ID_PREFIXES[kind];
  return z
    .string()
    .regex(new RegExp(`^${prefix}_[0-9a-zA-Z_-]{1,64}$`), `expected a ${kind} id like "${prefix}_…"`)
    .describe(`Identifier of a ${kind}, prefixed with "${prefix}_".`);
}

export const ProjectId = idSchema('project');
export const SourceId = idSchema('source');
export const TimelineId = idSchema('timeline');
export const TrackId = idSchema('track');
export const ClipId = idSchema('clip');
export const EffectId = idSchema('effect');
export const RevisionId = idSchema('revision');
export const EventId = idSchema('event');

export type ProjectId = z.infer<typeof ProjectId>;
export type SourceId = z.infer<typeof SourceId>;
export type TimelineId = z.infer<typeof TimelineId>;
export type TrackId = z.infer<typeof TrackId>;
export type ClipId = z.infer<typeof ClipId>;
export type EffectId = z.infer<typeof EffectId>;
export type RevisionId = z.infer<typeof RevisionId>;
export type EventId = z.infer<typeof EventId>;

let counter = 0;

/** Generate a fresh prefixed id. Sortable-ish: monotonic counter, then randomness. */
export function newId<K extends EntityKind>(kind: K): string {
  const random =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14).padEnd(12, '0');
  counter = (counter + 1) % 0xffff;
  return `${ID_PREFIXES[kind]}_${counter.toString(36).padStart(3, '0')}${random}`;
}

/**
 * Deterministic id factory for tests and for replaying a log into an identical EDL.
 * `makeIdFactory('t')` yields `clp_t1`, `clp_t2`, …
 */
export function makeIdFactory(seed: string): <K extends EntityKind>(kind: K) => string {
  let n = 0;
  return (kind) => `${ID_PREFIXES[kind]}_${seed}${++n}`;
}

/** Integer microseconds. See `time.ts` for why this is the canonical unit. */
export const MicrosSchema = z
  .number()
  .int('times must be whole microseconds')
  .describe('A time in integer microseconds.');

/** A time that cannot be negative: a duration, or an offset into media. */
export const NonNegativeMicrosSchema = MicrosSchema.min(0, 'must not be negative');

export const RationalSchema = z
  .object({
    num: z.number().int().positive(),
    den: z.number().int().positive(),
  })
  .describe('An exact rational, e.g. 29.97fps is { num: 30000, den: 1001 }.');


export const Resolution = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type Resolution = z.infer<typeof Resolution>;

/**
 * Interpolation from this keyframe to the next.
 * `hold` is a step: the value stays put until the next keyframe fires.
 */
export const Easing = z.enum(['linear', 'hold', 'easeIn', 'easeOut', 'easeInOut']);
export type Easing = z.infer<typeof Easing>;

export const Timestamp = z.iso.datetime().describe('ISO-8601 UTC timestamp.');

/**
 * Who made an edit, and why.
 *
 * This is the hinge of the whole product: the training set we are accumulating is
 * pairs of (human coarse decision, resulting footage). Provenance is what lets us
 * separate the human's cuts from the model's refinements later, when the log is
 * months old and nobody remembers which pass produced which clip.
 */
export const Actor = z.enum(['human', 'llm', 'import', 'system']);
export type Actor = z.infer<typeof Actor>;

export const Provenance = z.object({
  by: Actor,
  at: Timestamp.optional(),
  /** Revision that introduced this entity, for tracing back into the op log. */
  revisionId: RevisionId.optional(),
  /** Model's stated reason, kept verbatim. Training signal, not display text. */
  rationale: z.string().max(2000).optional(),
  /** Model identifier, when `by === 'llm'`. */
  model: z.string().max(200).optional(),
});
export type Provenance = z.infer<typeof Provenance>;
