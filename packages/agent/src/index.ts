import {
  RefinementPlan,
  commitOps,
  type Op,
  type OpError,
  type Project,
  type Revision,
} from '@evocut/edl';
import { REFINEMENT_SYSTEM_PROMPT, buildRefinementPrompt, refinementTool, type RefinementRequestOptions } from './prompt.js';

/**
 * `@evocut/agent` — the refinement pass.
 *
 * ## Status
 *
 * Implemented: prompt construction, response validation, and the apply/repair loop —
 * everything that does not require a network call, and therefore everything that can be
 * tested deterministically.
 *
 * Not implemented: the transport. `refineProject` takes a `complete` function rather than
 * calling a provider itself, so the loop is testable with a scripted model and the choice
 * of provider stays out of the package.
 */

export * from './prompt.js';

/** What the caller must supply: one round-trip to a model that can call tools. */
export type CompleteFn = (request: {
  system: string;
  prompt: string;
  tool: ReturnType<typeof refinementTool>;
}) => Promise<unknown>;

export interface RefineOptions extends RefinementRequestOptions {
  complete: CompleteFn;
  model?: string;
  /**
   * Extra attempts allowed for ops the engine rejected. One is usually enough: the
   * common failure is a stale id, and the repair prompt names it exactly.
   */
  maxRepairRounds?: number;
}

export interface RefineResult {
  project: Project;
  revisions: Revision[];
  /** Ops that never applied, after all repair rounds. */
  rejected: OpError[];
  summary?: string;
  rounds: number;
}

/**
 * Run a refinement pass and apply it.
 *
 * The applied ops are committed as a revision even when some were rejected, because a
 * revision records what happened rather than what was asked for. Rejected ops go back to
 * the model with their error messages; anything still failing after `maxRepairRounds` is
 * returned to the caller rather than retried forever.
 */
export async function refineProject(project: Project, options: RefineOptions): Promise<RefineResult> {
  const maxRepairRounds = options.maxRepairRounds ?? 1;
  const revisions: Revision[] = [];

  let current = project;
  let previousErrors: Array<{ op: unknown; message: string }> | undefined;
  let rejected: OpError[] = [];
  let summary: string | undefined;
  let rounds = 0;

  for (let round = 0; round <= maxRepairRounds; round++) {
    rounds = round + 1;

    const raw = await options.complete({
      system: REFINEMENT_SYSTEM_PROMPT,
      prompt: buildRefinementPrompt(current, { ...options, ...(previousErrors ? { previousErrors } : {}) }),
      tool: refinementTool(),
    });

    const plan = parseRefinementResponse(raw);
    if (round === 0) summary = plan.summary;
    if (plan.ops.length === 0) break;

    const result = commitOps(current, plan.ops, {
      by: 'llm',
      ...(plan.summary !== undefined ? { summary: plan.summary } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
    });

    current = result.project;
    revisions.push(result.revision);
    rejected = result.errors;

    if (rejected.length === 0) break;
    previousErrors = rejected.map((e) => ({ op: e.op, message: e.message }));
  }

  return {
    project: current,
    revisions,
    rejected,
    ...(summary !== undefined ? { summary } : {}),
    rounds,
  };
}

/**
 * Validate a model's tool input against the EDL's own op schema.
 *
 * Accepts either the tool input directly or a `{ ops: [...] }`-shaped wrapper, because
 * providers differ on how tool arguments arrive and this is not worth an adapter layer.
 */
export function parseRefinementResponse(raw: unknown): RefinementPlan {
  const parsed = RefinementPlan.safeParse(raw);
  if (parsed.success) return parsed.data;

  if (Array.isArray(raw)) {
    return RefinementPlan.parse({ ops: raw });
  }

  throw new Error(`Refinement response did not match the op schema: ${parsed.error.message}`);
}

/** Ops grouped by kind, for the review screen's summary line. */
export function summarizeOps(ops: Op[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const op of ops) counts[op.op] = (counts[op.op] ?? 0) + 1;
  return counts;
}
