/**
 * Which model the refinement pass asks for.
 *
 * Deliberately in its own module with no dependencies. The UI needs these strings, and if
 * they lived next to the transport, reading one would drag the whole Anthropic SDK into
 * the initial bundle of an app most of whose sessions never make an API call.
 *
 * Opus is the tier this task wants, and is the default. The pass reasons about timing
 * across a whole timeline — where a hit lands, whether a trim leaves the sentence intact —
 * and that is judgement, not extraction. The cheaper tiers are here because a nine-minute
 * assembly is a long prompt and some passes are worth running twice; the expensive one is
 * here because it is genuinely different at picking a moment, and it is marked as costing
 * real money rather than left to be discovered on a bill.
 */
export const DEFAULT_MODEL = 'claude-opus-5';

export interface ModelChoice {
  id: string;
  /** What it is, in the fewest words that distinguish it from its neighbours. */
  label: string;
  /** Shown under the picker when this one is selected. */
  note: string;
  /** True for a tier expensive enough that picking it should be a decision. */
  costly?: boolean;
}

export const MODELS: ModelChoice[] = [
  {
    id: 'claude-opus-5',
    label: 'Opus 5',
    note: 'The default, and the best judgement about where a cut lands.',
  },
  {
    id: 'claude-opus-4-8',
    label: 'Opus 4.8',
    note: 'The previous Opus. Same price as Opus 5 — worth a run if you want a second opinion.',
  },
  {
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    note: 'Quicker and about a third of the cost. Good for a first pass over a long assembly.',
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    note: 'The previous Sonnet.',
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Haiku 4.5',
    note: 'The cheapest and fastest. Shorter memory, so a very long timeline may not fit.',
  },
  {
    id: 'claude-fable-5',
    label: 'Fable 5',
    note: 'Expensive — twice Opus, and it will draw on paid usage credits once you pass your plan’s limit.',
    costly: true,
  },
];

/** The catalogue entry for a stored id, or null if it is one we do not know about. */
export function findModel(id: string): ModelChoice | null {
  return MODELS.find((model) => model.id === id) ?? null;
}
