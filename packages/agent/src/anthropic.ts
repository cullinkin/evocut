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
 * ## What leaves the device
 *
 * Always: the timeline description and the signals summary — text about the edit, not the
 * edit's contents. Never: audio, and never the video file.
 *
 * **Frames, only when the person has turned them on.** A pass that cannot see the footage
 * cannot tell you that four clips are the same moment filmed four times, which is most of
 * what a refinement pass is for; so frames are offered, and they are a real disclosure of
 * pictures of someone's life. The switch is on the Refine sheet next to the button that
 * spends the money, it is off until it is turned on, and what was sent is recorded in the
 * log for every pass.
 */

/**
 * Room for the model to think *and* answer.
 *
 * `max_tokens` caps thinking and response text together, and thinking is on by default on
 * this model — a budget sized around the ops alone truncates the answer mid-plan.
 *
 * It was 16,000, which was enough for the small passes it was built against and nowhere
 * near enough for the pass this tool actually exists to run. Nine minutes of footage asked
 * down to two and a half is fifty-odd clips to judge and a hundred-odd ops to emit; a real
 * session hit the ceiling at exactly 16,000 output tokens, `stop_reason: max_tokens`, with
 * the tool call cut off mid-emission. Sixty-four thousand is the model's limit and costs
 * nothing when unused — `max_tokens` is a ceiling, not a purchase.
 */
const MAX_TOKENS = 64_000;

/**
 * How long one call may take before the client gives up.
 *
 * A pass over fifty clips at high effort takes minutes, not seconds. The SDK's ten-minute
 * default is close enough to that to lose a good answer at the last moment.
 */
const TIMEOUT_MS = 20 * 60_000;

/** Roughly four characters to a token — only ever used to draw a progress line. */
const CHARS_PER_TOKEN = 4;

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
  /** Called as the answer arrives, so a four-minute wait can show something. */
  onProgress?: (progress: AnthropicProgress) => void;
}

export interface AnthropicUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
  stopReason: string | null;
}

/**
 * What the model is doing right now, as far as the wire can tell.
 *
 * `ops` is counted out of the partial JSON rather than parsed from it — a half-written
 * plan is not valid JSON and never will be until it finishes. Counting `"op":` in the
 * stream is exact for the schema this tool uses and is only ever shown as a number to
 * someone waiting.
 */
export interface AnthropicProgress {
  phase: 'thinking' | 'drafting';
  /** Rough output tokens so far. */
  tokens: number;
  /** Edits the partial plan appears to contain. */
  ops: number;
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
    timeout: TIMEOUT_MS,
    // One retry, not two. Each attempt at this size is minutes long, and three of them
    // back to back is half an hour of a phone screen saying nothing.
    maxRetries: 1,
    // Refuses to construct in a browser without this, which is the correct default for a
    // library and the wrong one for an app whose entire premise is running on the phone.
    dangerouslyAllowBrowser: options.allowBrowser ?? true,
  });

  return async ({ system, content, tool }) => {
    /**
     * Streamed, and not for the typewriter effect.
     *
     * A pass over fifty clips takes minutes, and a non-streaming request spends all of
     * them with nothing on the wire. A phone on LTE does not keep an idle connection open
     * that long — the first failure of a real session was `APIConnectionError` after nine
     * minutes, which is not the API refusing anything, it is the socket going quiet and
     * being collected. A stream has bytes moving throughout, and as a bonus it can say
     * how the plan is coming along while it comes along.
     */
    const stream = client.messages.stream(
      {
        model: options.model ?? DEFAULT_MODEL,
        max_tokens: MAX_TOKENS,
        system,
        messages: [
          {
            role: 'user',
            content: content.map((block) =>
              block.type === 'image'
                ? {
                    type: 'image' as const,
                    source: {
                      type: 'base64' as const,
                      media_type: block.mediaType as 'image/jpeg',
                      data: block.data,
                    },
                  }
                : { type: 'text' as const, text: block.text },
            ),
          },
        ],
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

    if (options.onProgress) watch(stream, options.onProgress);

    const message = await stream.finalMessage();

    onUsage?.({
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      model: message.model,
      stopReason: message.stop_reason,
    });

    return readToolInput(message, tool.name);
  };
}

/** Turn the raw event stream into something a progress line can show. */
function watch(
  stream: { on(event: 'streamEvent', handler: (event: unknown) => void): unknown },
  report: (progress: AnthropicProgress) => void,
): void {
  let phase: AnthropicProgress['phase'] = 'thinking';
  let chars = 0;
  let ops = 0;
  // Carried across deltas because the marker can be split across two of them. Exactly one
  // character short of the marker, so anything found in `tail + piece` must reach into the
  // new piece and cannot be something already counted.
  const marker = '"op":';
  let tail = '';

  stream.on('streamEvent', (raw) => {
    const event = raw as {
      type?: string;
      content_block?: { type?: string };
      delta?: { type?: string; partial_json?: string; thinking?: string; text?: string };
    };

    if (event.type === 'content_block_start') {
      phase = event.content_block?.type === 'thinking' ? 'thinking' : 'drafting';
      return;
    }
    if (event.type !== 'content_block_delta') return;

    const piece = event.delta?.partial_json ?? event.delta?.thinking ?? event.delta?.text ?? '';
    if (!piece) return;
    chars += piece.length;

    if (event.delta?.partial_json !== undefined) {
      const window = tail + piece;
      ops += window.split(marker).length - 1;
      tail = window.slice(-(marker.length - 1));
    }

    report({ phase, tokens: Math.round(chars / CHARS_PER_TOKEN), ops });
  });
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
 *  - **Truncation.** `stop_reason: "max_tokens"` means the plan was cut mid-emission.
 *    Checked *before* the tool call is read, which is the whole lesson: a truncated tool
 *    call still arrives as a `tool_use` block, with whatever partial JSON the SDK could
 *    salvage — usually `{}`. Reading it first therefore produced
 *    `expected "array" at path ["ops"]`, which is a true statement about a corpse and
 *    tells the person holding the phone nothing about what went wrong.
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

  if (message.stop_reason === 'max_tokens') {
    throw new Error(
      'The model ran out of room before finishing its plan. Try again — or lower how hard it thinks, in Settings, which leaves more of the budget for the edits themselves.',
    );
  }

  const call = message.content.find((block) => block.type === 'tool_use' && block.name === toolName);
  if (call) return call.input;

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
    // Worth the extra sentence: a pass over a long timeline runs for minutes, and the way
    // it fails on a phone is the screen locking rather than the network being down.
    return 'Could not reach the API. A pass over a long edit takes minutes — keep this tab in front and the phone awake, and try again.';
  }
  if (cause instanceof Anthropic.APIError) {
    return `The API returned an error (${cause.status ?? 'unknown'}): ${cause.message}`;
  }
  return cause instanceof Error ? cause.message : String(cause);
}
