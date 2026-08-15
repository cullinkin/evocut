import { z } from 'zod';
import { Op, RefinementPlan } from './schema/ops.js';
import { Project } from './schema/project.js';
import { Timeline } from './schema/timeline.js';

/**
 * JSON Schema generation for LLM tool definitions.
 *
 * The refinement pass is a tool call whose `input_schema` is generated from the exact same
 * zod schema the engine validates against. That identity is the point: hand-writing a JSON
 * Schema for the prompt and validating with a separate zod schema guarantees they drift,
 * and the failure mode is a model dutifully producing output that the engine rejects.
 *
 * `io: 'input'` is what we want for tool schemas — fields with defaults are described as
 * optional, so the model is not pushed to restate `enabled: true` on every clip.
 */
export type JsonSchema = Record<string, unknown>;

const TARGET = 'draft-2020-12' as const;

export function opJsonSchema(): JsonSchema {
  return z.toJSONSchema(Op, { target: TARGET, io: 'input' }) as JsonSchema;
}

export function refinementPlanJsonSchema(): JsonSchema {
  return z.toJSONSchema(RefinementPlan, { target: TARGET, io: 'input' }) as JsonSchema;
}

export function timelineJsonSchema(): JsonSchema {
  return z.toJSONSchema(Timeline, { target: TARGET, io: 'input' }) as JsonSchema;
}

export function projectJsonSchema(): JsonSchema {
  return z.toJSONSchema(Project, { target: TARGET, io: 'input' }) as JsonSchema;
}

/**
 * A ready-to-use tool definition for the refinement pass, in Anthropic tool format.
 * The agent package supplies the surrounding prompt; this keeps the contract next to
 * the schema it comes from.
 */
export function refinementToolDefinition(): {
  name: string;
  description: string;
  input_schema: JsonSchema;
} {
  return {
    name: 'propose_edits',
    description:
      'Propose refinement edits to the timeline. Emit one op per discrete decision, each ' +
      'with a short rationale. Times are in integer microseconds on the output timeline ' +
      'unless the field name says "source". Reference clips by the ids given in the ' +
      'timeline description; do not invent ids. After a split, the right-hand half has a ' +
      'new id, so later ops in the same batch must account for it.',
    input_schema: refinementPlanJsonSchema(),
  };
}
