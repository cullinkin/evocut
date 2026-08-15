import { z } from 'zod';
import { Actor, EventId, MicrosSchema, ProjectId, RevisionId, Timestamp } from './common.js';
import { Op } from './ops.js';

/**
 * Append-only capture of the coarse pass.
 *
 * The EDL says *what* the user kept. This log says *how they got there* — where they
 * scrubbed, what they watched twice, which cut they made and then undid. That process
 * signal is the reason to log at all: a finished EDL alone cannot tell you whether a cut
 * point was deliberate or the first thing the user tried.
 *
 * Two design choices follow from it being a capture stream rather than a document:
 *
 *  - **Permissive payloads.** `type` is checked against a known list, but `payload` is an
 *    open record. A schema mismatch at write time would drop an event we can never
 *    re-record; a mismatch at *read* time is just a row we skip during export. Losing the
 *    data is the worse failure, so validation lives on the read side.
 *  - **Playhead on every row.** Attention is the signal. Knowing the playhead sat at
 *    00:04:12 for eleven seconds before a cut landed there is worth more than the cut.
 */
export const LOG_EVENT_TYPES = [
  // lifecycle
  'project.create',
  'project.open',
  'source.import',
  'source.probe',
  // What the media element reports it can do with the bytes it was handed. Logged
  // because "the video plays but will not seek" is invisible from the EDL alone, and it
  // is the difference between an editor and a video player.
  'media.diagnostics',
  // What the analysis pass measured, and how long it took. The cost of measuring a
  // recording is a property of the phone doing it, and cannot be observed anywhere else.
  'signals.compute',
  // transport — the attention trail
  'playback.play',
  'playback.pause',
  'playback.seek',
  'playback.rate',
  'playback.scrub',
  // coarse editing
  'mark.in',
  'mark.out',
  'range.keep',
  'range.delete',
  'clip.split',
  'clip.trim',
  'clip.remove',
  'clip.move',
  'clip.restore',
  'edit.undo',
  'edit.redo',
  // handoff and refinement
  'coarse.commit',
  // What the user said this video is meant to be, and how long. Steers every later pass.
  'project.brief',
  'llm.request',
  'llm.plan',
  'llm.error',
  'llm.apply',
  // One suggestion accepted or taken back. Its own row rather than a diff of the final
  // state: a person who accepts an edit, watches it, and takes it back has told us
  // something a final verdict cannot, and it is only visible here.
  'llm.verdict',
  'llm.review',
  // output
  'render.start',
  'render.complete',
  'render.error',
] as const;

export const LogEventType = z.enum(LOG_EVENT_TYPES);
export type LogEventType = z.infer<typeof LogEventType>;

export const LogEvent = z.object({
  id: EventId,
  projectId: ProjectId,
  /** Monotonic per project. Wall-clock alone is not orderable across a clock change. */
  seq: z.number().int().nonnegative(),
  at: Timestamp,
  actor: Actor,
  type: LogEventType,

  /** Playhead when the event fired. Absent for events with no transport context. */
  playhead: MicrosSchema.optional(),
  /** Event-specific detail. Deliberately open — see the note above. */
  payload: z.record(z.string(), z.unknown()).default({}),
  /** Ops this event applied, when it was an edit. */
  ops: z.array(Op).optional(),
  /** Revision the timeline was at *after* this event. */
  revisionId: RevisionId.optional(),
  /** Digest of the timeline after this event, for detecting a desynced replay. */
  timelineDigest: z.string().optional(),
});
export type LogEvent = z.infer<typeof LogEvent>;

/** Serialize a log to JSONL — one event per line, appendable without a rewrite. */
export function serializeLog(events: LogEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n');
}

export interface ParsedLog {
  events: LogEvent[];
  /** Lines that failed to parse or validate, with the reason. Never throws them away. */
  skipped: Array<{ line: number; raw: string; error: string }>;
}

/**
 * Parse JSONL back into events. Bad lines are collected rather than thrown, because a
 * single truncated write (a phone losing the tab mid-append) must not cost us the session.
 */
export function parseLog(jsonl: string): ParsedLog {
  const events: LogEvent[] = [];
  const skipped: ParsedLog['skipped'] = [];

  jsonl.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    try {
      const parsed = LogEvent.safeParse(JSON.parse(line));
      if (parsed.success) {
        events.push(parsed.data);
      } else {
        skipped.push({ line: index + 1, raw: line, error: parsed.error.message });
      }
    } catch (error) {
      skipped.push({ line: index + 1, raw: line, error: String(error) });
    }
  });

  events.sort((a, b) => a.seq - b.seq);
  return { events, skipped };
}

/**
 * Incrementing sequence numbers for one project's log.
 *
 * `startSeq` resumes an existing log: reopening a project has to continue its sequence,
 * not restart it, or the new rows would collide with the stored ones and a replay would
 * silently lose whichever side lost the write.
 */
export function makeLogger(
  projectId: string,
  newEventId: () => string,
  now: () => string,
  startSeq = 0,
) {
  let seq = startSeq;
  return function record(
    type: LogEventType,
    actor: Actor,
    detail: Partial<Omit<LogEvent, 'id' | 'projectId' | 'seq' | 'at' | 'actor' | 'type'>> = {},
  ): LogEvent {
    return {
      id: newEventId(),
      projectId,
      seq: seq++,
      at: now(),
      actor,
      type,
      payload: {},
      ...detail,
    };
  };
}
