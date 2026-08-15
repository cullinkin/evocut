/**
 * Which model the refinement pass asks for.
 *
 * Deliberately in its own module with no dependencies. The settings screen needs this
 * string, and if it lived next to the transport, reading it would drag the whole Anthropic
 * SDK into the initial bundle of an app most of whose sessions never make an API call.
 *
 * Opus is the tier this task wants. The pass reasons about timing across a whole
 * timeline — where a hit lands, whether a trim leaves the sentence intact — and that is
 * judgement, not extraction.
 */
export const DEFAULT_MODEL = 'claude-opus-5';
