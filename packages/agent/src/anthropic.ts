import Anthropic from '@anthropic-ai/sdk';
import type { CompleteFn } from './index.js';
import { DEFAULT_MODEL } from './models.js';

/**
 * The transport: one round trip to Claude.
 *
 * Everything else in this package is provider-agnostic on purpose — `refineProject` and
 * `proposeRefinement` take a `complete` function so the loop is testable against a
 * scripted model. This file is the one place that knows about a vendor, and it is
 * deliberately thin: build a request, read one tool call out of the response.
 *
 * ## Where it runs, and what that costs
 *
 * In the browser, against the user's own key. EvoCut is a static site with no server, and
 * a phone with no network round trip through infrastructure that does not exist is the
 * whole reason the editor works offline. The trade-off is real and stated in the settings
 * screen: a key held in a browser is readable by anything that can run script on the page.
 * For a personal tool with a revocable key that is a reasonable bargain; for a shared
 * deployment it is not, which is why `baseUrl` exists — point it at a proxy that holds the
 * key server-side and the rest of this file is unchanged.
 *
 * **Only text leaves the device**: the timeline description and the signals summary. No
 * frames, no audio, no footage.
 */

/**
 * Room for the model to think *and* answer.
 *
 * `max_tokens` caps thinking and response text together, and thinking is on by default on
 * this model — a budget sized around the ops alone truncates the answer mid-plan.
 */
const MAX_TOKENS = 16_000;

export interface AnthropicOptions {
  apiKey: string;
  model?: string;
  /** Depth of reasoning. `high` is the API default; `low` is markedly cheaper and faster. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Point at a proxy instead of the API. The proxy holds the key; this one can be a stub. */
  baseUrl?: string;
  /** Injected by the tests, which drive the real client against a stub transport. */
  fetch?: typeof fetch;
  /** Off only where there is no browser to be dangerous in. */
  allowBrowser?: boolean;
  signal?: AbortSignal;
}

export interface AnthropicUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
  stopReason: string | null;
}

/**
 * A `CompleteFn` backed by the Claude API.
 *
 * `onUsage` reports what the call actually cost. That is not instrumentation for its own
 * sake: this pass runs on a phone against a key the user pays for, and "how much does a
 * refinement cost" is a question they will ask after the first one.
 */
export function createAnthropicComplete(
  options: AnthropicOptions,
  onUsage?: (usage: AnthropicUsage) => void,
): CompleteFn {
  const client = new Anthropic({
    apiKey: options.apiKey,
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    // Refuses to construct in a browser without this, which is the correct default for a
    // library and the wrong one for an app whose entire premise is running on the phone.
    dangerouslyAllowBrowser: options.allowBrowser ?? true,
  });

  return async ({ system, prompt, tool }) => {
    const message = await client.messages.create(
      {
        model: options.model ?? DEFAULT_MODEL,
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: prompt }],
        // The EDL generates this schema from the same zod definition the engine validates
        // against, so it is a JSON Schema object at runtime — but it is typed as an open
        // record, which the SDK's stricter `input_schema` will not accept on faith.
        tools: [tool as Anthropic.Tool],
        // Adaptive thinking, and deliberately *not* a forced `tool_choice`. Turning
        // thinking off to force the call would trade a reliable tool call for a documented
        // failure mode where the call arrives as plain text and silently never runs — the
        // exact problem forcing was meant to solve. The system prompt asks for the tool;
        // a reply without one is treated as a parse failure and gets the repair round.
        thinking: { type: 'adaptive' },
        ...(options.effort ? { output_config: { effort: options.effort } } : {}),
      },
      options.signal ? { signal: options.signal } : {},
    );

    onUsage?.({
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      model: message.model,
      stopReason: message.stop_reason,
    });

    return readToolInput(message, tool.name);
  };
}

/**
 * Pull the proposal out of the response.
 *
 * Three ways this does not go as planned, and all three are worth distinguishing, because
 * "the refinement failed" is useless to someone holding a phone:
 *
 *  - **A refusal.** Safety classifiers can decline a request; that arrives as a normal
 *    successful response with `stop_reason: "refusal"` and possibly no content at all, so
 *    reading `content[0]` first would throw something misleading.
 *  - **Truncation.** `stop_reason: "max_tokens"` means the plan was cut mid-emission. The
 *    tool input will not parse, and saying so beats a schema error.
 *  - **Prose instead of a tool call.** The model answered in text. That is a real outcome
 *    of not forcing the tool, and the repair round exists for it — but the message should
 *    say what happened rather than reporting an empty plan.
 */
export function readToolInput(
  message: {
    content: Array<{ type: string; name?: string; input?: unknown; text?: string }>;
    stop_reason: string | null;
  },
  toolName: string,
): unknown {
  if (message.stop_reason === 'refusal') {
    throw new Error('The model declined this request. Nothing was changed.');
  }

  const call = message.content.find((block) => block.type === 'tool_use' && block.name === toolName);
  if (call) return call.input;

  if (message.stop_reason === 'max_tokens') {
    throw new Error('The model ran out of room before finishing its plan. Try a shorter timeline.');
  }

  const said = message.content
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text)
    .join(' ')
    .trim();

  throw new Error(
    said
      ? `The model replied without proposing any edits: ${said.slice(0, 300)}`
      : 'The model returned no proposal.',
  );
}

/**
 * Turn a failed call into something worth showing a person.
 *
 * The SDK's own messages are accurate and unhelpful ("401 status code (no body)"). Each of
 * these has a different fix, and the fix is the only part that matters on a phone.
 */
export function describeApiError(cause: unknown): string {
  if (cause instanceof Anthropic.AuthenticationError) {
    return 'That API key was rejected. Check it in Settings.';
  }
  if (cause instanceof Anthropic.PermissionDeniedError) {
    return 'That key does not have access to this model.';
  }
  if (cause instanceof Anthropic.RateLimitError) {
    return 'Rate limited by the API. Wait a moment and try again.';
  }
  if (cause instanceof Anthropic.APIConnectionError) {
    return 'Could not reach the API. Check your connection.';
  }
  if (cause instanceof Anthropic.APIError) {
    return `The API returned an error (${cause.status ?? 'unknown'}): ${cause.message}`;
  }
  return cause instanceof Error ? cause.message : String(cause);
}
