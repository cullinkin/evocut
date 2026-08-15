import { describe, expect, it } from 'vitest';
import {
  createClip,
  createProject,
  createTimeline,
  createTrack,
  makeIdFactory,
  refinementToolDefinition,
  secondsToMicros as S,
  type Project,
  type Source,
} from '@evocut/edl';
import { createAnthropicComplete, describeApiError, readToolInput } from '../src/anthropic.js';
import { proposeRefinement } from '../src/index.js';

/**
 * The transport is tested through the real SDK, against a stub `fetch`.
 *
 * Mocking the client would test the mock. What can actually go wrong here is the wire: a
 * missing header, a tool the model can't see, a response shape read incorrectly — none of
 * which a hand-written double would reproduce, because a double agrees with whatever the
 * caller believes. Injecting `fetch` puts the SDK's own request building and response
 * parsing in the path and leaves only the network out.
 */
function stubTransport(reply: unknown, status = 200) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];

  const fetchStub: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    calls.push({
      url: String(input),
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });

    // Errors come back as JSON; the SDK never streams a non-2xx.
    if (status !== 200) {
      return new Response(JSON.stringify(reply), { status, headers: { 'content-type': 'application/json' } });
    }
    return new Response(sse(reply as AnyMessage), {
      status,
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  return { fetchStub, calls };
}

interface AnyMessage {
  content: Array<{ type: string; id?: string; name?: string; input?: unknown; text?: string; thinking?: string }>;
  usage: { input_tokens: number; output_tokens: number };
  stop_reason: string | null;
  [key: string]: unknown;
}

/**
 * Re-encode a finished message as the event stream that produced it.
 *
 * The transport streams now, so a stub that answers with a whole JSON message is testing a
 * code path the app no longer takes. This keeps the tests written in terms of the answer —
 * `toolCallReply({ ops })` — while putting the SDK's real SSE decoder and its accumulator
 * in the path, which is where a truncated tool call becomes `{}` and where the bug that
 * produced "expected array at ops" actually lived.
 *
 * Deltas are emitted in pieces rather than whole, because a stream that always delivers a
 * complete JSON value in one chunk cannot catch a counter that breaks across a boundary.
 */
function sse(message: AnyMessage): string {
  const lines: string[] = [];
  const emit = (type: string, data: Record<string, unknown>) =>
    lines.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);

  emit('message_start', {
    message: { ...message, content: [], usage: { ...message.usage, output_tokens: 0 } },
  });

  message.content.forEach((block, index) => {
    const body =
      block.type === 'tool_use'
        ? { type: 'tool_use', id: block.id ?? 'toolu_stub', name: block.name, input: {} }
        : block.type === 'thinking'
          ? { type: 'thinking', thinking: '', signature: '' }
          : { type: 'text', text: '' };
    emit('content_block_start', { index, content_block: body });

    const payload =
      block.type === 'tool_use'
        ? JSON.stringify(block.input ?? {})
        : block.type === 'thinking'
          ? block.thinking ?? ''
          : block.text ?? '';

    for (let at = 0; at < payload.length; at += 7) {
      const piece = payload.slice(at, at + 7);
      const delta =
        block.type === 'tool_use'
          ? { type: 'input_json_delta', partial_json: piece }
          : block.type === 'thinking'
            ? { type: 'thinking_delta', thinking: piece }
            : { type: 'text_delta', text: piece };
      emit('content_block_delta', { index, delta });
    }
    if (block.type === 'thinking') {
      emit('content_block_delta', { index, delta: { type: 'signature_delta', signature: 'sig' } });
    }
    emit('content_block_stop', { index });
  });

  emit('message_delta', {
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { output_tokens: message.usage.output_tokens },
  });
  emit('message_stop', {});

  return lines.join('');
}

function toolCallReply(input: unknown, over: Record<string, unknown> = {}) {
  return {
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 340 },
    content: [{ type: 'tool_use', id: 'toolu_01', name: 'propose_edits', input }],
    ...over,
  };
}

const source: Source = {
  id: 'src_take1',
  locator: { kind: 'opfs', path: 'take1.mp4' },
  name: 'take1.mp4',
  duration: S(300),
};

function project(): Project {
  const d = { newId: makeIdFactory('t') };
  const clips = [
    createClip({ sourceId: source.id, sourceIn: 0, sourceOut: S(10) }, d),
    createClip({ sourceId: source.id, sourceIn: S(20), sourceOut: S(30) }, d),
  ];
  return createProject(
    { sources: [source], timeline: createTimeline({ tracks: [createTrack({ kind: 'video', clips }, d)] }, d) },
    d,
  );
}

describe('createAnthropicComplete', () => {
  const request = {
    system: 'You refine edits.',
    prompt: 'Timeline description here.',
    tool: refinementToolDefinition(),
  };

  it('sends the tool whose schema the engine validates against', async () => {
    const { fetchStub, calls } = stubTransport(toolCallReply({ ops: [] }));
    const complete = createAnthropicComplete({ apiKey: 'sk-test', fetch: fetchStub });
    await complete(request);

    const [call] = calls;
    expect(call!.body.tools).toHaveLength(1);
    expect(call!.body.tools[0].name).toBe('propose_edits');
    // The same JSON Schema the EDL generates from its own zod op schema. If these ever
    // diverge, the model produces output the engine rejects — the failure this identity
    // exists to prevent.
    expect(call!.body.tools[0].input_schema).toEqual(refinementToolDefinition().input_schema);
  });

  it('asks for adaptive thinking and does not force the tool call', async () => {
    const { fetchStub, calls } = stubTransport(toolCallReply({ ops: [] }));
    await createAnthropicComplete({ apiKey: 'sk-test', fetch: fetchStub })(request);

    expect(calls[0]!.body.thinking).toEqual({ type: 'adaptive' });
    // Forcing the tool would mean turning thinking off, which on this model can make a
    // tool call arrive as plain text that silently never runs. The prompt asks instead.
    expect(calls[0]!.body.tool_choice).toBeUndefined();
    expect(calls[0]!.body.temperature).toBeUndefined();
  });

  it('identifies itself as a browser caller, or the API refuses on CORS', async () => {
    const { fetchStub, calls } = stubTransport(toolCallReply({ ops: [] }));
    await createAnthropicComplete({ apiKey: 'sk-test', fetch: fetchStub })(request);

    expect(calls[0]!.headers['x-api-key']).toBe('sk-test');
    expect(calls[0]!.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
  });

  it('carries the model and effort when they are set', async () => {
    const { fetchStub, calls } = stubTransport(toolCallReply({ ops: [] }));
    await createAnthropicComplete({
      apiKey: 'sk-test',
      model: 'claude-sonnet-5',
      effort: 'low',
      fetch: fetchStub,
    })(request);

    expect(calls[0]!.body.model).toBe('claude-sonnet-5');
    expect(calls[0]!.body.output_config).toEqual({ effort: 'low' });
  });

  it('leaves effort off when unset, rather than guessing the API default', async () => {
    const { fetchStub, calls } = stubTransport(toolCallReply({ ops: [] }));
    await createAnthropicComplete({ apiKey: 'sk-test', fetch: fetchStub })(request);
    expect(calls[0]!.body.output_config).toBeUndefined();
  });

  it('reports what the call cost', async () => {
    const { fetchStub } = stubTransport(toolCallReply({ ops: [] }));
    const seen: unknown[] = [];
    await createAnthropicComplete({ apiKey: 'sk-test', fetch: fetchStub }, (usage) => seen.push(usage))(
      request,
    );

    expect(seen).toEqual([
      { inputTokens: 1200, outputTokens: 340, model: 'claude-opus-5', stopReason: 'tool_use' },
    ]);
  });

  it('returns the tool input for the op parser', async () => {
    const plan = { summary: 'Tightened the joins.', ops: [{ op: 'remove', clipId: 'clp_x' }] };
    const { fetchStub } = stubTransport(toolCallReply(plan));
    expect(await createAnthropicComplete({ apiKey: 'sk-test', fetch: fetchStub })(request)).toEqual(plan);
  });

  it('sends only text — never the footage', async () => {
    const { fetchStub, calls } = stubTransport(toolCallReply({ ops: [] }));
    await createAnthropicComplete({ apiKey: 'sk-test', fetch: fetchStub })(request);

    // Every content block in the request is text. A stray image or document block here
    // would mean frames of someone's recording leaving the device.
    const content = calls[0]!.body.messages.flatMap((message: any) =>
      typeof message.content === 'string' ? [{ type: 'text' }] : message.content,
    );
    expect(content.every((block: any) => block.type === 'text')).toBe(true);
  });

  /**
   * Streamed, with room to finish.
   *
   * Both halves come from the same session. The first call spent nine minutes with nothing
   * on the wire and died of `APIConnectionError` — a phone on LTE does not hold an idle
   * socket that long. The second got through and hit the ceiling at exactly 16,000 output
   * tokens with `stop_reason: max_tokens`, because a nine-minute assembly asked down to two
   * and a half is a hundred-odd ops and the budget was sized for a handful.
   */
  it('streams, so a pass that takes minutes keeps the connection alive', async () => {
    const { fetchStub, calls } = stubTransport(toolCallReply({ ops: [] }));
    await createAnthropicComplete({ apiKey: 'sk-test', fetch: fetchStub })(request);
    expect(calls[0]!.body.stream).toBe(true);
  });

  it('asks for enough room to emit a plan for a long timeline', async () => {
    const { fetchStub, calls } = stubTransport(toolCallReply({ ops: [] }));
    await createAnthropicComplete({ apiKey: 'sk-test', fetch: fetchStub })(request);
    expect(calls[0]!.body.max_tokens).toBeGreaterThanOrEqual(64_000);
  });

  /**
   * The bug this ordering exists for.
   *
   * A truncated tool call is still a `tool_use` block — the SDK hands back whatever partial
   * JSON it could salvage, which for a plan cut mid-op is `{}`. Reading the input first
   * therefore reported `expected "array" at path ["ops"]`: true, useless, and the actual
   * text a person saw on their phone.
   */
  it('calls a truncated tool call what it is, not a schema error', async () => {
    const { fetchStub } = stubTransport(
      toolCallReply({ summary: 'Cutting the mid', ops: [{ op: 'remo' }] }, { stop_reason: 'max_tokens' }),
    );
    const complete = createAnthropicComplete({ apiKey: 'sk-test', fetch: fetchStub });
    await expect(complete(request)).rejects.toThrow(/ran out of room/i);
  });

  it('reports how the plan is coming along while it comes along', async () => {
    const { fetchStub } = stubTransport(
      toolCallReply({
        summary: 'Three edits.',
        ops: [
          { op: 'remove', clipId: 'clp_a' },
          { op: 'remove', clipId: 'clp_b' },
          { op: 'trim', clipId: 'clp_c', sourceIn: 10 },
        ],
      }),
    );

    const seen: Array<{ phase: string; ops: number; tokens: number }> = [];
    await createAnthropicComplete({ apiKey: 'sk-test', fetch: fetchStub, onProgress: (p) => seen.push(p) })(
      request,
    );

    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)!.phase).toBe('drafting');
    // Counted out of the partial JSON, across delta boundaries — the stub deliberately
    // splits every seven characters, so `"op":` lands astride a chunk more than once.
    expect(seen.at(-1)!.ops).toBe(3);
    expect(seen.at(-1)!.tokens).toBeGreaterThan(0);
  });

  it('says when the model is still thinking rather than writing', async () => {
    const { fetchStub } = stubTransport(
      toolCallReply({ ops: [] }, {
        content: [
          { type: 'thinking', thinking: 'Weighing the joins against the target length.' },
          { type: 'tool_use', id: 'toolu_01', name: 'propose_edits', input: { ops: [] } },
        ],
      }),
    );

    const seen: Array<{ phase: string }> = [];
    await createAnthropicComplete({ apiKey: 'sk-test', fetch: fetchStub, onProgress: (p) => seen.push(p) })(
      request,
    );

    expect(seen[0]!.phase).toBe('thinking');
    expect(seen.at(-1)!.phase).toBe('drafting');
  });

  it('can be pointed at a proxy instead of the API', async () => {
    const { fetchStub, calls } = stubTransport(toolCallReply({ ops: [] }));
    await createAnthropicComplete({
      apiKey: 'unused',
      baseUrl: 'https://edge.example/anthropic',
      fetch: fetchStub,
    })(request);

    expect(calls[0]!.url).toBe('https://edge.example/anthropic/v1/messages');
  });
});

describe('readToolInput', () => {
  it('says plainly when the model declined', () => {
    expect(() => readToolInput({ content: [], stop_reason: 'refusal' }, 'propose_edits')).toThrow(
      /declined/i,
    );
  });

  it('distinguishes truncation from a bad plan', () => {
    expect(() =>
      readToolInput({ content: [{ type: 'text', text: 'I will' }], stop_reason: 'max_tokens' }, 'propose_edits'),
    ).toThrow(/ran out of room/i);
  });

  it('quotes the model back when it answered in prose', () => {
    expect(() =>
      readToolInput(
        { content: [{ type: 'text', text: 'The timeline already looks tight.' }], stop_reason: 'end_turn' },
        'propose_edits',
      ),
    ).toThrow(/already looks tight/);
  });

  it('ignores a tool call that is not the one we asked for', () => {
    expect(() =>
      readToolInput(
        { content: [{ type: 'tool_use', name: 'something_else', input: { ops: [] } }], stop_reason: 'tool_use' },
        'propose_edits',
      ),
    ).toThrow(/no proposal/i);
  });
});

describe('describeApiError', () => {
  it('turns a rejected key into the action that fixes it', async () => {
    // A real 401 through the real SDK, so this asserts on the exception class the SDK
    // actually throws rather than on one this test invented.
    const { fetchStub } = stubTransport(
      { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
      401,
    );
    const complete = createAnthropicComplete({ apiKey: 'sk-wrong', fetch: fetchStub });

    const failure = await complete({ system: 's', prompt: 'p', tool: refinementToolDefinition() }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).not.toBeNull();
    expect(describeApiError(failure)).toBe('That API key was rejected. Check it in Settings.');
  });

  it('falls through to the API’s own message for anything unclassified', () => {
    expect(describeApiError(new Error('socket hang up'))).toBe('socket hang up');
  });
});

describe('proposeRefinement', () => {
  it('validates the plan without applying it', async () => {
    const tl = project();
    const clipId = tl.timeline.tracks[0]!.clips[0]!.id;
    const { fetchStub } = stubTransport(
      toolCallReply({ summary: 'One trim.', ops: [{ op: 'trim', clipId, sourceIn: S(1) }] }),
    );

    const result = await proposeRefinement(tl, {
      complete: createAnthropicComplete({ apiKey: 'sk-test', fetch: fetchStub }),
    });

    expect(result.plan.ops).toHaveLength(1);
    expect(result.rejected).toEqual([]);
    // The project is untouched — the whole point. An edit applied before it is judged can
    // only be undone, never rejected.
    expect(tl.timeline.tracks[0]!.clips[0]!.sourceIn).toBe(0);
    expect(tl.revisions).toHaveLength(0);
  });

  it('drops ops that would not apply, so they never reach the review screen', async () => {
    const tl = project();
    const clipId = tl.timeline.tracks[0]!.clips[0]!.id;
    const { fetchStub } = stubTransport(
      toolCallReply({
        ops: [
          { op: 'trim', clipId, sourceIn: S(1) },
          { op: 'remove', clipId: 'clp_doesnotexist' },
        ],
      }),
    );

    const result = await proposeRefinement(tl, {
      complete: createAnthropicComplete({ apiKey: 'sk-test', fetch: fetchStub }),
      maxRepairRounds: 0,
    });

    expect(result.plan.ops).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.message).toMatch(/clp_doesnotexist/);
  });

  it('sends the failures back for one repair round and keeps what survived', async () => {
    const tl = project();
    const clipId = tl.timeline.tracks[0]!.clips[0]!.id;
    const otherId = tl.timeline.tracks[0]!.clips[1]!.id;

    const rounds: string[] = [];
    const complete = async ({ prompt }: { prompt: string }) => {
      rounds.push(prompt);
      return rounds.length === 1
        ? { ops: [{ op: 'trim', clipId, sourceIn: S(1) }, { op: 'remove', clipId: 'clp_gone' }] }
        : { ops: [{ op: 'setSpeed', clipId: otherId, speed: 1.5 }] };
    };

    const result = await proposeRefinement(tl, { complete });

    expect(rounds).toHaveLength(2);
    // The repair prompt names the op that failed, which is why one round is usually enough.
    expect(rounds[1]).toMatch(/clp_gone/);
    expect(result.plan.ops.map((op) => op.op)).toEqual(['trim', 'setSpeed']);
    expect(result.rejected).toEqual([]);
    expect(result.rounds).toBe(2);
  });

  it('does not list an op twice when the repair round resends it', async () => {
    // Models resend the ops that already landed, however clearly the repair prompt asks
    // them not to. Listed twice is a wasted review slot; accepted twice is a double edit.
    const tl = project();
    const clipId = tl.timeline.tracks[0]!.clips[0]!.id;
    const good = { op: 'trim', clipId, sourceIn: S(1) };

    const result = await proposeRefinement(tl, {
      complete: async () => ({ ops: [good, { op: 'remove', clipId: 'clp_gone' }] }),
    });

    expect(result.rounds).toBe(2);
    expect(result.plan.ops).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
  });

  it('stops asking when the model proposes nothing', async () => {
    let calls = 0;
    const result = await proposeRefinement(project(), {
      complete: async () => {
        calls += 1;
        return { summary: 'Nothing worth changing.', ops: [] };
      },
    });

    expect(calls).toBe(1);
    expect(result.plan.ops).toEqual([]);
    expect(result.plan.summary).toBe('Nothing worth changing.');
  });
});
