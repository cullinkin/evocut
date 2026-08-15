import { describe, expect, it } from 'vitest';
import {
  createClip,
  createTimeline,
  createTrack,
  lengthStanding,
  makeIdFactory,
  previewOps,
  resolveReview,
  secondsToMicros as S,
  timelineDuration,
  type Op,
  type ReviewSession,
  type Timeline,
} from '../src/index.js';

/**
 * A live review: derived, not mutated.
 *
 * The property these tests exist for is that accepting and un-accepting are the *same*
 * operation with a different argument. If un-accepting were an undo — an inverse op
 * applied to whatever the timeline had become — then a sequence of toggles could leave the
 * timeline somewhere neither the user nor the log could account for. Deriving from the
 * baseline every time makes that structurally impossible, and the way to demonstrate it is
 * to toggle things back and forth and land exactly where we started.
 */

function deps() {
  return { newId: makeIdFactory('r') };
}

function baseline(): Timeline {
  const d = deps();
  const clips = [
    createClip({ sourceId: 'src_a', sourceIn: S(0), sourceOut: S(10) }, d),
    createClip({ sourceId: 'src_a', sourceIn: S(20), sourceOut: S(32) }, d),
    createClip({ sourceId: 'src_a', sourceIn: S(40), sourceOut: S(46) }, d),
  ];
  return createTimeline({ tracks: [createTrack({ kind: 'video', clips }, d)] }, d);
}

function session(ops: Op[], accepted?: boolean[]): ReviewSession {
  return {
    id: 'rev_1',
    by: 'model',
    model: 'claude-opus-5',
    ops,
    accepted: accepted ?? ops.map(() => false),
    baseline: baseline(),
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

const ids = () => baseline().tracks[0]!.clips.map((clip) => clip.id);

describe('resolveReview', () => {
  it('shows the untouched edit when nothing is accepted', () => {
    const [a] = ids();
    const resolved = resolveReview(session([{ op: 'remove', clipId: a! }]));
    expect(timelineDuration(resolved.timeline)).toBe(S(28));
    expect(resolved.landed).toEqual([false]);
  });

  it('applies only what was accepted', () => {
    const [a, b] = ids();
    const ops: Op[] = [
      { op: 'remove', clipId: a! },
      { op: 'setSpeed', clipId: b!, speed: 2 },
    ];
    const resolved = resolveReview(session(ops, [false, true]));
    // Clip a stays (10s), clip b halves (12s → 6s), clip c unchanged (6s).
    expect(timelineDuration(resolved.timeline)).toBe(S(22));
    expect(resolved.landed).toEqual([false, true]);
  });

  it('returns to exactly where it started when a suggestion is taken back', () => {
    const [a, b] = ids();
    const ops: Op[] = [
      { op: 'trim', clipId: a!, sourceIn: S(2) },
      { op: 'setSpeed', clipId: b!, speed: 1.5 },
      { op: 'remove', clipId: b! },
    ];

    const none = resolveReview(session(ops, [false, false, false])).timeline;
    const all = resolveReview(session(ops, [true, true, true])).timeline;
    expect(timelineDuration(all)).toBeLessThan(timelineDuration(none));

    // Ticked on, then off again — byte for byte the timeline we began with. This is the
    // whole claim: taking a suggestion back is not an approximate reversal.
    const backAgain = resolveReview(session(ops, [true, true, true]));
    expect(backAgain.landed).toEqual([true, true, true]);
    expect(resolveReview(session(ops, [false, false, false])).timeline).toEqual(none);
  });

  it('applies in the order proposed, not the order ticked', () => {
    const [, b] = ids();
    const ops: Op[] = [
      { op: 'trim', clipId: b!, sourceOut: S(30) },
      { op: 'setSpeed', clipId: b!, speed: 2 },
    ];
    // A trim then a speed change: 10s of source at 2x is 5s. The other order would give
    // the same clip a different length, which is why the tick order must not decide it.
    const resolved = resolveReview(session(ops, [true, true]));
    expect(timelineDuration(resolved.timeline)).toBe(S(10) + S(5) + S(6));
  });

  it('reports an accepted op that no longer applies instead of dropping it', () => {
    const ops: Op[] = [{ op: 'remove', clipId: 'clp_gone' }];
    const resolved = resolveReview(session(ops, [true]));
    expect(resolved.landed).toEqual([false]);
    expect(resolved.failures[0]?.index).toBe(0);
    expect(resolved.failures[0]?.message).toMatch(/clp_gone/);
  });

  it('pins the failure to the right suggestion when an earlier one was skipped', () => {
    const [a] = ids();
    const ops: Op[] = [
      { op: 'remove', clipId: a! },
      { op: 'remove', clipId: 'clp_gone' },
      { op: 'setSpeed', clipId: 'clp_alsogone', speed: 2 },
    ];
    // Only the last two are accepted, so `applyOps` sees a two-op batch and indexes its
    // errors 0 and 1 — which are ops 1 and 2 here. Reporting those verbatim would put the
    // red mark on the wrong rows.
    const resolved = resolveReview(session(ops, [false, true, true]));
    expect(resolved.failures.map((failure) => failure.index)).toEqual([1, 2]);
    expect(resolved.landed).toEqual([false, false, false]);
  });
});

describe('previewOps', () => {
  it('says what a trim takes off, and from which end', () => {
    const [a] = ids();
    const open = session([{ op: 'trim', clipId: a!, sourceIn: S(1.5), sourceOut: S(9) }]);
    const [preview] = previewOps(open, open.baseline);

    expect(preview!.headline).toBe('Trim 1.50s off the head and 1.00s off the tail');
    expect(preview!.beforeLengthUs).toBe(S(10));
    expect(preview!.afterLengthUs).toBe(S(7.5));
    expect(preview!.deltaUs).toBe(-S(2.5));
    expect(preview!.applicable).toBe(true);
  });

  it('says what a speed change costs in seconds, not in multiples', () => {
    const [, b] = ids();
    const open = session([{ op: 'setSpeed', clipId: b!, speed: 2 }]);
    expect(previewOps(open, open.baseline)[0]!.headline).toBe('Play at 2× — 12.00s becomes 6.00s');
  });

  it('says how much a dropped shot is worth', () => {
    const [, , c] = ids();
    const open = session([{ op: 'setEnabled', clipId: c!, enabled: false }]);
    const [preview] = previewOps(open, open.baseline);
    expect(preview!.headline).toBe('Drop this shot — 6.00s out');
    expect(preview!.deltaUs).toBe(-S(6));
  });

  it('measures each suggestion on its own, against the untouched edit', () => {
    const [a] = ids();
    const ops: Op[] = [
      { op: 'trim', clipId: a!, sourceIn: S(2) },
      { op: 'trim', clipId: a!, sourceOut: S(8) },
    ];
    // Both accepted, both touching the same clip. Each preview still reports what *it*
    // does to the original — the alternative, differencing cumulative states, would credit
    // the second op with a shorter clip than the user is being asked about.
    const previews = previewOps(session(ops, [true, true]), baseline());
    expect(previews.map((preview) => preview.deltaUs)).toEqual([-S(2), -S(2)]);
  });

  it('marks a suggestion whose clip has gone, and still gives it a position', () => {
    const open = session([{ op: 'trim', clipId: 'clp_gone', sourceIn: S(1) }]);
    const [preview] = previewOps(open, open.baseline);
    expect(preview!.applicable).toBe(false);
    expect(preview!.reason).toMatch(/clp_gone/);
    expect(preview!.anchorUs).toBe(0);
  });

  it('anchors a bubble over its clip on the timeline actually on screen', () => {
    const [a, b] = ids();
    // Accepting the first suggestion pulls clip b two seconds earlier; the bubble for the
    // second has to move with it, or it points at the wrong shot.
    const ops: Op[] = [
      { op: 'trim', clipId: a!, sourceIn: S(2) },
      { op: 'setSpeed', clipId: b!, speed: 2 },
    ];
    const open = session(ops, [true, false]);
    const visible = resolveReview(open).timeline;

    const [, moved] = previewOps(open, visible);
    const [, unmoved] = previewOps(open, open.baseline);
    expect(unmoved!.anchorUs - moved!.anchorUs).toBe(S(2));
  });
});

describe('lengthStanding', () => {
  it('says nothing about a target that was never set', () => {
    expect(lengthStanding(baseline(), undefined)).toMatchObject({ overUs: null, label: '0:28' });
  });

  it('says how far over, in the words someone cutting to length would use', () => {
    expect(lengthStanding(baseline(), S(70)).label).toBe('0:28 of 1:10 — 0:42 under');
    expect(lengthStanding(baseline(), S(10)).label).toBe('0:28 of 0:10 — 0:18 over');
    expect(lengthStanding(baseline(), S(28)).label).toBe('0:28 — on target');
  });
});
