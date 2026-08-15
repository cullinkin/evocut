import { newId as defaultNewId, type EntityKind } from './schema/common.js';
import { clipEnd, outputDuration, timelineToSource, type Clip } from './schema/clip.js';
import { findClip, findTrack, type Timeline } from './schema/timeline.js';
import type { Op } from './schema/ops.js';
import type { Source } from './schema/source.js';
import { normalizeTimeline } from './normalize.js';
import { splitEffect } from './interpolate.js';

export interface ApplyContext {
  /** Used to bounds-check trims and inserts against real media. Skipped when absent. */
  sources?: Source[];
  /** Injectable for deterministic tests and log replay. */
  newId?: (kind: EntityKind) => string;
}

export interface OpError {
  /** Position in the submitted batch, so a repair prompt can name the offending op. */
  index: number;
  op: Op;
  message: string;
}

export interface ApplyResult {
  timeline: Timeline;
  applied: Op[];
  errors: OpError[];
}

/**
 * Apply a batch of ops to a timeline. Pure: the input is never mutated.
 *
 * **A failed op is skipped, not fatal.** This matters more than it looks. A refinement
 * pass is twenty ops and the model will get one of them wrong — a stale clip id after its
 * own earlier split, a trim four frames past the end. Throwing would discard nineteen good
 * edits; instead we apply what is valid and hand the errors back, which is also exactly the
 * feedback a repair round needs.
 *
 * Ops are applied in order against the running result, so later ops see earlier ones.
 * The timeline is renormalized after each op, which is why a `split` at an absolute
 * timeline time behaves sanely even after an earlier `remove` rippled everything left.
 */
export function applyOps(timeline: Timeline, ops: Op[], ctx: ApplyContext = {}): ApplyResult {
  const newId = ctx.newId ?? defaultNewId;
  let working: Timeline = structuredClone(timeline);
  const applied: Op[] = [];
  const errors: OpError[] = [];

  ops.forEach((op, index) => {
    try {
      working = normalizeTimeline(applyOne(working, op, { ...ctx, newId }));
      applied.push(op);
    } catch (error) {
      errors.push({ index, op, message: error instanceof Error ? error.message : String(error) });
    }
  });

  return { timeline: working, applied, errors };
}

/** Apply a single op. Throws `OpFailure` on any invalid edit; `applyOps` collects those. */
function applyOne(timeline: Timeline, op: Op, ctx: Required<Pick<ApplyContext, 'newId'>> & ApplyContext): Timeline {
  switch (op.op) {
    case 'trim': {
      const { clip, track, index } = locate(timeline, op.clipId);
      const sourceIn = op.sourceIn ?? clip.sourceIn;
      const sourceOut = op.sourceOut ?? clip.sourceOut;
      assert(sourceIn >= 0, `trim: sourceIn ${sourceIn} is negative`);
      assert(
        sourceOut > sourceIn,
        `trim: sourceOut ${sourceOut} must be greater than sourceIn ${sourceIn} (clip ${clip.id})`,
      );
      const source = lookupSource(ctx, clip.sourceId);
      if (source) {
        assert(
          sourceOut <= source.duration,
          `trim: sourceOut ${sourceOut} runs past the end of source ${source.id} (${source.duration})`,
        );
      }
      return replaceClip(timeline, track.id, index, { ...clip, sourceIn, sourceOut });
    }

    case 'split': {
      const { clip, track, index } = locate(timeline, op.clipId);
      assert(
        op.at > clip.start && op.at < clipEnd(clip),
        `split: ${op.at} is not strictly inside clip ${clip.id} [${clip.start}, ${clipEnd(clip)})`,
      );
      const sourceAt = timelineToSource(clip, op.at);
      assert(sourceAt !== null, `split: ${op.at} does not map into clip ${clip.id}`);
      assert(
        sourceAt > clip.sourceIn && sourceAt < clip.sourceOut,
        `split: cut point lands on a clip edge (clip ${clip.id})`,
      );

      const offset = op.at - clip.start;
      const pairs = clip.effects.map((effect) => splitEffect(effect, offset));

      const left: Clip = {
        ...clip,
        sourceOut: sourceAt,
        effects: pairs.map(([l]) => l),
      };
      const right: Clip = {
        ...clip,
        id: op.newClipId ?? ctx.newId('clip'),
        sourceIn: sourceAt,
        start: op.at,
        // A split is a machine edit even when it inherits a human clip's history.
        effects: pairs.map(([, r]) => ({ ...r, id: ctx.newId('effect') })),
      };

      const clips = [...track.clips];
      clips.splice(index, 1, left, right);
      return replaceTrackClips(timeline, track.id, clips);
    }

    case 'remove': {
      const { track, index } = locate(timeline, op.clipId);
      const clips = [...track.clips];
      clips.splice(index, 1);
      return replaceTrackClips(timeline, track.id, clips);
    }

    case 'setEnabled': {
      const { clip, track, index } = locate(timeline, op.clipId);
      return replaceClip(timeline, track.id, index, { ...clip, enabled: op.enabled });
    }

    case 'move': {
      const { clip, track, index } = locate(timeline, op.clipId);
      const clips = [...track.clips];
      clips.splice(index, 1);
      const target = Math.min(op.toIndex, clips.length);
      clips.splice(target, 0, clip);
      return replaceTrackClips(timeline, track.id, clips);
    }

    case 'setSpeed': {
      const { clip, track, index } = locate(timeline, op.clipId);
      assert(op.speed > 0, `setSpeed: speed must be positive (clip ${clip.id})`);
      const next = { ...clip, speed: op.speed };
      assert(
        outputDuration(next) > 0,
        `setSpeed: speed ${op.speed} collapses clip ${clip.id} to zero length`,
      );
      return replaceClip(timeline, track.id, index, next);
    }

    case 'addEffect': {
      const { clip, track, index } = locate(timeline, op.clipId);
      assert(
        !clip.effects.some((e) => e.id === op.effect.id),
        `addEffect: effect ${op.effect.id} is already on clip ${clip.id}`,
      );
      assertKeyframesSorted(op.effect);
      return replaceClip(timeline, track.id, index, {
        ...clip,
        effects: [...clip.effects, op.effect],
      });
    }

    case 'removeEffect': {
      const { clip, track, index } = locate(timeline, op.clipId);
      assert(
        clip.effects.some((e) => e.id === op.effectId),
        `removeEffect: clip ${clip.id} has no effect ${op.effectId}`,
      );
      return replaceClip(timeline, track.id, index, {
        ...clip,
        effects: clip.effects.filter((e) => e.id !== op.effectId),
      });
    }

    case 'setAudio': {
      const { clip, track, index } = locate(timeline, op.clipId);
      return replaceClip(timeline, track.id, index, {
        ...clip,
        audio: { ...clip.audio, ...op.audio },
      });
    }

    case 'setLabel': {
      const { clip, track, index } = locate(timeline, op.clipId);
      return replaceClip(timeline, track.id, index, { ...clip, label: op.label });
    }

    case 'insertClip': {
      const track = findTrack(timeline, op.trackId);
      assert(track !== null, `insertClip: no track ${op.trackId}`);
      assert(
        op.sourceOut > op.sourceIn,
        `insertClip: sourceOut ${op.sourceOut} must be greater than sourceIn ${op.sourceIn}`,
      );
      const source = lookupSource(ctx, op.sourceId);
      if (ctx.sources) {
        assert(source !== null, `insertClip: no source ${op.sourceId}`);
        assert(
          op.sourceOut <= source!.duration,
          `insertClip: sourceOut ${op.sourceOut} runs past the end of source ${op.sourceId}`,
        );
      }

      const clip: Clip = {
        id: op.clipId ?? ctx.newId('clip'),
        sourceId: op.sourceId,
        sourceIn: op.sourceIn,
        sourceOut: op.sourceOut,
        start: 0,
        speed: op.speed ?? 1,
        enabled: true,
        audio: { gain: 1, mute: false },
        effects: [],
      };

      const clips = [...track!.clips];
      clips.splice(Math.min(op.atIndex ?? clips.length, clips.length), 0, clip);
      return replaceTrackClips(timeline, track!.id, clips);
    }
  }
}

function locate(timeline: Timeline, clipId: string) {
  const found = findClip(timeline, clipId);
  // By far the most common model error: referring to a clip it removed or split earlier
  // in the same batch. Name it explicitly so a repair round can fix it without guessing.
  assert(found !== null, `no clip ${clipId} on the timeline`);
  return found!;
}

function lookupSource(ctx: ApplyContext, sourceId: string): Source | null {
  return ctx.sources?.find((s) => s.id === sourceId) ?? null;
}

function replaceClip(timeline: Timeline, trackId: string, index: number, clip: Clip): Timeline {
  return {
    ...timeline,
    tracks: timeline.tracks.map((track) =>
      track.id === trackId
        ? { ...track, clips: track.clips.map((existing, i) => (i === index ? clip : existing)) }
        : track,
    ),
  };
}

function replaceTrackClips(timeline: Timeline, trackId: string, clips: Clip[]): Timeline {
  return {
    ...timeline,
    tracks: timeline.tracks.map((track) => (track.id === trackId ? { ...track, clips } : track)),
  };
}

function assertKeyframesSorted(effect: { type: string; keyframes?: Array<{ t: number }> }): void {
  if (!effect.keyframes) return;
  for (let i = 1; i < effect.keyframes.length; i++) {
    assert(
      effect.keyframes[i]!.t >= effect.keyframes[i - 1]!.t,
      `addEffect: keyframes must be in ascending time order (${effect.type})`,
    );
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
