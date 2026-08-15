import {
  RefinementPlan,
  applyOps,
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
 * Prompt construction, response validation, and the apply/repair loop. Nothing here makes
 * a network call: `refineProject` and `proposeRefinement` take a `complete` function, so
 * the loop is exercised against a scripted model and the choice of provider stays out of
 * the way. The Claude transport that satisfies that contract lives in `./anthropic`, one
 * import away and deliberately not re-exported from here.
 *
 * Two entry points, and the difference is who decides:
 *
 *  - `proposeRefinement` returns a validated plan and applies nothing. This is what the
 *    app uses, because a person is about to judge every op.
 *  - `refineProject` applies as it goes. For a pipeline with no human in it.
 */

export * from './prompt.js';
export * from './local.js';
export * from './models.js';

// `./anthropic` is deliberately NOT re-exported here. It is the only module in this
// package with a vendor dependency, and re-exporting it would put the Anthropic SDK in
// the bundle of every app that imports the prompt builder. Consumers reach it through the
// `@evocut/agent/anthropic` subpath, which the web app loads on demand.

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

export interface ProposeOptions extends RefinementRequestOptions {
  complete: CompleteFn;
  /** Extra attempts allowed for ops the engine rejected. */
  maxRepairRounds?: number;
}

export interface Proposal {
  /** Only the ops that were checked and apply cleanly. Not committed to anything. */
  plan: RefinementPlan;
  /** Ops that never applied, after all repair rounds. Worth showing; never silently dropped. */
  rejected: OpError[];
  rounds: number;
}

/**
 * Ask for a refinement pass and validate it — without applying it.
 *
 * The difference from `refineProject` is the whole point of the review screen. That
 * function commits as it goes, which is right for an autonomous pipeline and wrong here:
 * the human has not seen the suggestions yet, and an edit that lands before it is judged
 * cannot be rejected, only undone. So the ops are dry-run against a copy of the timeline —
 * enough to catch a stale id or an out-of-range trim — and then handed back as a plan.
 *
 * Rejected ops still go through the repair round. A wasted review slot is worse than a
 * wasted round trip: the reviewer's attention is the scarce resource, and an op that was
 * never going to apply spends it for nothing.
 */
export async function proposeRefinement(project: Project, options: ProposeOptions): Promise<Proposal> {
  const maxRepairRounds = options.maxRepairRounds ?? 1;
  let ops: Op[] = [];
  let rejected: OpError[] = [];
  let summary: string | undefined;
  let previousErrors: Array<{ op: unknown; message: string }> | undefined;
  let rounds = 0;

  for (let round = 0; round <= maxRepairRounds; round += 1) {
    rounds = round + 1;

    const raw = await options.complete({
      system: REFINEMENT_SYSTEM_PROMPT,
      prompt: buildRefinementPrompt(project, { ...options, ...(previousErrors ? { previousErrors } : {}) }),
      tool: refinementTool(),
    });

    const plan = parseRefinementResponse(raw);
    if (round === 0) summary = plan.summary;
    if (plan.ops.length === 0) break;

    // Validated as one batch against the original timeline, not incrementally. Ops are
    // order-dependent — a split creates the clip a later op trims — so checking a repair
    // round's ops in isolation would accept a batch that falls apart when applied together.
    const candidate = round === 0 ? plan.ops : withoutResends([...ops, ...plan.ops]);
    const result = applyOps(project.timeline, candidate, { sources: project.sources });

    ops = result.applied;
    rejected = result.errors;
    if (rejected.length === 0) break;
    previousErrors = rejected.map((error) => ({ op: error.op, message: error.message }));
  }

  return {
    plan: { ops, ...(summary !== undefined ? { summary } : {}) },
    rejected,
    rounds,
  };
}

/**
 * Drop exact resends from a repair round.
 *
 * The repair prompt asks the model not to resend the ops that already landed. Models do it
 * anyway, and combining the rounds blindly costs twice: the reviewer sees the same
 * suggestion listed twice, and accepting both applies the edit twice.
 *
 * Exact structural equality only. Two ops that mean the same thing in different words are
 * still two proposals, and merging those would be the engine second-guessing the model.
 */
function withoutResends(ops: Op[]): Op[] {
  const seen = new Set<string>();
  return ops.filter((op) => {
    const key = JSON.stringify(op, Object.keys(op).sort());
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
