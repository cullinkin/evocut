import { describe, expect, it } from 'vitest';
import { Op, RefinementPlan } from '../src/schema/ops.js';
import { Project, SCHEMA_VERSION } from '../src/schema/project.js';
import { Clip } from '../src/schema/clip.js';
import { parseLog, serializeLog, type LogEvent } from '../src/schema/log.js';
import { canonicalJson, digestTimeline } from '../src/digest.js';
import { opJsonSchema, refinementToolDefinition } from '../src/jsonschema.js';
import { describeProject, describeTimeline } from '../src/describe.js';
import { commitOps, freezeCoarsePass } from '../src/factory.js';
import { droppedRegions } from '../src/normalize.js';
import { COARSE_CLIP_IDS, makeCoarseProject, makeCoarseTimeline, S, testDeps } from './fixtures.js';

const [FIRST, SECOND] = COARSE_CLIP_IDS;

describe('project round-trip', () => {
  it('survives JSON serialization unchanged', () => {
    const project = makeCoarseProject();
    const reparsed = Project.parse(JSON.parse(JSON.stringify(project)));
    expect(reparsed).toEqual(project);
  });

  it('keeps cut points exact through the round-trip', () => {
    // The reason times are integer microseconds rather than float seconds: a cut written
    // and re-read has to be the same cut, to the microsecond.
    const project = makeCoarseProject();
    const reparsed = Project.parse(JSON.parse(JSON.stringify(project)));
    expect(digestTimeline(reparsed.timeline)).toBe(digestTimeline(project.timeline));
  });

  it('rejects a fractional microsecond', () => {
    const clip = { ...makeCoarseTimeline().tracks[0]!.clips[0]!, sourceIn: 1000.5 };
    expect(Clip.safeParse(clip).success).toBe(false);
  });

  it('rejects a mistyped id prefix', () => {
    // A track id where a clip id belongs is the most likely LLM slip; the prefix
    // turns it into a schema failure instead of a silent no-op.
    const result = Op.safeParse({ op: 'remove', clipId: 'trk_t4' });
    expect(result.success).toBe(false);
  });

  it('pins the schema version', () => {
    expect(SCHEMA_VERSION).toBe(1);
    expect(Project.safeParse({ ...makeCoarseProject(), schemaVersion: 2 }).success).toBe(false);
  });
});

describe('op parsing', () => {
  it('accepts a well-formed refinement plan', () => {
    const plan = RefinementPlan.parse({
      summary: 'Tightened the joins and added a push-in on the demo.',
      ops: [
        { op: 'trim', clipId: FIRST, sourceIn: S(2.4), rationale: 'clip starts on a breath' },
        { op: 'setSpeed', clipId: SECOND, speed: 1.25, rationale: 'walk-over is slow' },
      ],
    });
    expect(plan.ops).toHaveLength(2);
  });

  it('rejects an unknown op kind', () => {
    expect(Op.safeParse({ op: 'transcode', clipId: FIRST }).success).toBe(false);
  });

  it('rejects a speed outside the supported range', () => {
    expect(Op.safeParse({ op: 'setSpeed', clipId: FIRST, speed: 0 }).success).toBe(false);
    expect(Op.safeParse({ op: 'setSpeed', clipId: FIRST, speed: 100 }).success).toBe(false);
  });
});

describe('json schema generation', () => {
  it('produces a tool definition covering every op kind', () => {
    const tool = refinementToolDefinition();
    expect(tool.name).toBe('propose_edits');

    // The tool schema and the validating schema are generated from one source, so the
    // model can never be asked for a shape the engine would reject.
    const serialized = JSON.stringify(opJsonSchema());
    for (const kind of [
      'trim',
      'split',
      'remove',
      'setEnabled',
      'move',
      'setSpeed',
      'addEffect',
      'removeEffect',
      'setAudio',
      'setLabel',
      'insertClip',
    ]) {
      expect(serialized).toContain(`"${kind}"`);
    }
  });
});

describe('digest', () => {
  it('ignores key order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('changes when a cut point moves by one microsecond', () => {
    const timeline = makeCoarseTimeline();
    const moved = structuredClone(timeline);
    moved.tracks[0]!.clips[0]!.sourceOut += 1;
    expect(digestTimeline(moved)).not.toBe(digestTimeline(timeline));
  });
});

describe('log', () => {
  const events: LogEvent[] = [
    {
      id: 'evt_1',
      projectId: 'prj_t4',
      seq: 0,
      at: '2026-01-01T00:00:00.000Z',
      actor: 'human',
      type: 'playback.seek',
      playhead: S(12),
      payload: { from: 0 },
    },
    {
      id: 'evt_2',
      projectId: 'prj_t4',
      seq: 1,
      at: '2026-01-01T00:00:01.000Z',
      actor: 'human',
      type: 'range.delete',
      playhead: S(12),
      payload: { start: S(10), end: S(18) },
      ops: [{ op: 'trim', clipId: FIRST, sourceOut: S(10) }],
    },
  ];

  it('round-trips through JSONL', () => {
    expect(parseLog(serializeLog(events)).events).toEqual(events);
  });

  it('keeps good rows when one line is corrupt', () => {
    // A phone losing the tab mid-append truncates one line. Dropping the whole
    // session for it would cost data we cannot re-record.
    const jsonl = `${serializeLog(events)}\n{"id":"evt_3","proje`;
    const parsed = parseLog(jsonl);
    expect(parsed.events).toHaveLength(2);
    expect(parsed.skipped).toHaveLength(1);
    expect(parsed.skipped[0]!.line).toBe(3);
  });

  it('orders by sequence, not by arrival', () => {
    const shuffled = [events[1]!, events[0]!];
    expect(parseLog(serializeLog(shuffled)).events.map((e) => e.seq)).toEqual([0, 1]);
  });
});

describe('training-set path', () => {
  it('derives the regions the human dropped', () => {
    // The EDL records what was kept; the label we want to learn is keep-or-drop over
    // the whole recording, which needs the complement.
    expect(droppedRegions(makeCoarseTimeline(), 'src_take1', S(60))).toEqual([
      { start: 0, end: S(2) },
      { start: S(10), end: S(18) },
      { start: S(30), end: S(44) },
      { start: S(52), end: S(60) },
    ]);
  });

  it('freezes the coarse pass so refinements cannot overwrite it', () => {
    const d = testDeps('f');
    const coarse = freezeCoarsePass(makeCoarseProject(), d);
    expect(coarse.stage).toBe('handoff');

    const refined = commitOps(
      coarse,
      [{ op: 'trim', clipId: FIRST, sourceIn: S(3), rationale: 'drop the breath' }],
      { by: 'llm', model: 'test-model', summary: 'tightened the head', ...d },
    ).project;

    expect(refined.timeline.tracks[0]!.clips[0]!.sourceIn).toBe(S(3));
    // The human's version is still intact and still attributable.
    expect(refined.coarseSnapshot!.tracks[0]!.clips[0]!.sourceIn).toBe(S(2));
    expect(refined.revisions.at(-1)!.by).toBe('llm');
    expect(refined.revisions.at(-1)!.ops[0]!.rationale).toBe('drop the breath');
  });

  it('records only the ops that actually applied', () => {
    const d = testDeps('g');
    const result = commitOps(
      makeCoarseProject(),
      [
        { op: 'setLabel', clipId: FIRST, label: 'opening' },
        { op: 'remove', clipId: 'clp_ghost' },
      ],
      { by: 'llm', ...d },
    );

    // A revision has to replay to the timeline it produced, so it stores what applied,
    // not what was proposed. The rejects come back separately for a repair round.
    expect(result.revision.ops).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.project.headRevisionId).toBe(result.revision.id);
  });
});

describe('prompt rendering', () => {
  it('shows clip ids, both time formats, and where the human cut', () => {
    const text = describeTimeline(makeCoarseTimeline());
    expect(text).toContain(FIRST);
    expect(text).toContain('00:00:08.000');
    expect(text).toContain('8000000us');
    // The coarse cuts are what the refinement pass is being asked to clean up.
    expect(text).toContain('coarse cut: dropped 00:00:08.000 of source here');
    expect(text).toContain('coarse cut: dropped 00:00:14.000 of source here');
  });

  it('lists sources so the model can restore dropped footage', () => {
    const text = describeProject(makeCoarseProject());
    expect(text).toContain('src_take1');
    expect(text).toContain('stage: coarse');
  });
});
