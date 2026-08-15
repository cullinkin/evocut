import { outputDuration } from './schema/clip.js';
import type { Timeline } from './schema/timeline.js';
import { Project } from './schema/project.js';
import type { Source } from './schema/source.js';
import { normalizeTimeline } from './normalize.js';

/**
 * Semantic validation, i.e. everything zod cannot express.
 *
 * Zod checks that a field is a non-negative integer. It cannot check that `sourceOut`
 * falls inside a source it has never seen, that two clips claim the same id, or that
 * `start` still matches what a reflow would produce. Those are the failures that actually
 * reach the renderer, so they get their own pass — one that reports *all* problems rather
 * than dying on the first, because the caller is often an LLM that needs the full list.
 */

export type IssueSeverity = 'error' | 'warning';

export interface Issue {
  severity: IssueSeverity;
  code: string;
  message: string;
  /** Dotted path to the offending value, e.g. `timeline.tracks[0].clips[3].sourceOut`. */
  path?: string;
  clipId?: string;
}

export interface ValidateOptions {
  sources?: Source[];
  /** Warn when a cut point is not on an output frame boundary. Off during the coarse pass. */
  requireFrameAlignment?: boolean;
}

export function validateTimeline(timeline: Timeline, options: ValidateOptions = {}): Issue[] {
  const issues: Issue[] = [];
  const seenClipIds = new Set<string>();
  const seenTrackIds = new Set<string>();
  const sources = new Map((options.sources ?? []).map((s) => [s.id, s]));

  // Reflowing a correct timeline is a no-op, so any difference is drift: something
  // mutated clips without normalizing, and the renderer would place them wrong.
  const reflowed = normalizeTimeline(timeline);

  timeline.tracks.forEach((track, trackIndex) => {
    const trackPath = `tracks[${trackIndex}]`;
    if (seenTrackIds.has(track.id)) {
      issues.push({
        severity: 'error',
        code: 'duplicate-track-id',
        message: `Duplicate track id ${track.id}.`,
        path: trackPath,
      });
    }
    seenTrackIds.add(track.id);

    track.clips.forEach((clip, clipIndex) => {
      const path = `${trackPath}.clips[${clipIndex}]`;

      if (seenClipIds.has(clip.id)) {
        issues.push({
          severity: 'error',
          code: 'duplicate-clip-id',
          message: `Duplicate clip id ${clip.id}. Ops address clips by id, so this makes edits ambiguous.`,
          path,
          clipId: clip.id,
        });
      }
      seenClipIds.add(clip.id);

      if (clip.sourceOut <= clip.sourceIn) {
        issues.push({
          severity: 'error',
          code: 'empty-clip',
          message: `Clip ${clip.id} has sourceOut (${clip.sourceOut}) <= sourceIn (${clip.sourceIn}).`,
          path: `${path}.sourceOut`,
          clipId: clip.id,
        });
      }

      const source = sources.get(clip.sourceId);
      if (options.sources && !source) {
        issues.push({
          severity: 'error',
          code: 'missing-source',
          message: `Clip ${clip.id} references source ${clip.sourceId}, which is not in the project.`,
          path: `${path}.sourceId`,
          clipId: clip.id,
        });
      } else if (source && clip.sourceOut > source.duration) {
        issues.push({
          severity: 'error',
          code: 'out-of-bounds',
          message: `Clip ${clip.id} ends at ${clip.sourceOut} but source ${source.id} is only ${source.duration} long.`,
          path: `${path}.sourceOut`,
          clipId: clip.id,
        });
      }

      const expected = reflowed.tracks[trackIndex]?.clips.find((c) => c.id === clip.id);
      if (expected && expected.start !== clip.start) {
        issues.push({
          severity: 'error',
          code: 'position-drift',
          message: `Clip ${clip.id} starts at ${clip.start} but a reflow puts it at ${expected.start}. Call normalizeTimeline() after mutating.`,
          path: `${path}.start`,
          clipId: clip.id,
        });
      }

      const clipOut = outputDuration(clip);
      for (const [effectIndex, effect] of clip.effects.entries()) {
        const effectPath = `${path}.effects[${effectIndex}]`;
        if (!('keyframes' in effect)) continue;

        for (let i = 1; i < effect.keyframes.length; i++) {
          if (effect.keyframes[i]!.t < effect.keyframes[i - 1]!.t) {
            issues.push({
              severity: 'error',
              code: 'unsorted-keyframes',
              message: `Effect ${effect.id} on clip ${clip.id} has keyframes out of time order.`,
              path: `${effectPath}.keyframes[${i}]`,
              clipId: clip.id,
            });
            break;
          }
        }

        const last = effect.keyframes.at(-1);
        if (last && last.t > clipOut) {
          issues.push({
            severity: 'warning',
            code: 'keyframe-past-end',
            message: `Effect ${effect.id} on clip ${clip.id} has a keyframe at ${last.t}, past the clip's ${clipOut} output length. It will never be reached.`,
            path: `${effectPath}.keyframes`,
            clipId: clip.id,
          });
        }
      }

      if (options.requireFrameAlignment) {
        const step = (1_000_000 * timeline.frameRate.den) / timeline.frameRate.num;
        for (const [field, value] of [
          ['sourceIn', clip.sourceIn],
          ['sourceOut', clip.sourceOut],
        ] as const) {
          if (Math.abs(value / step - Math.round(value / step)) > 1e-6) {
            issues.push({
              severity: 'warning',
              code: 'not-frame-aligned',
              message: `Clip ${clip.id} ${field} (${value}) is not on a frame boundary; the renderer will snap it.`,
              path: `${path}.${field}`,
              clipId: clip.id,
            });
          }
        }
      }
    });

    if (track.kind === 'video') {
      const enabled = track.clips.filter((c) => c.enabled);
      for (let i = 1; i < enabled.length; i++) {
        const prev = enabled[i - 1]!;
        const current = enabled[i]!;
        if (current.start < prev.start + outputDuration(prev)) {
          issues.push({
            severity: 'error',
            code: 'overlap',
            message: `Clips ${prev.id} and ${current.id} overlap on video track ${track.id}.`,
            path: `${trackPath}.clips`,
            clipId: current.id,
          });
        }
      }
    }
  });

  return issues;
}

export function validateProject(project: Project, options: ValidateOptions = {}): Issue[] {
  const issues = validateTimeline(project.timeline, { sources: project.sources, ...options });

  if (project.headRevisionId && !project.revisions.some((r) => r.id === project.headRevisionId)) {
    issues.push({
      severity: 'error',
      code: 'dangling-head',
      message: `headRevisionId ${project.headRevisionId} is not in revisions.`,
      path: 'headRevisionId',
    });
  }

  if (project.stage !== 'coarse' && !project.coarseSnapshot) {
    issues.push({
      severity: 'warning',
      code: 'missing-coarse-snapshot',
      message: `Project is at stage "${project.stage}" with no coarseSnapshot. The human's coarse pass is the training signal — freeze it at handoff or it is gone.`,
      path: 'coarseSnapshot',
    });
  }

  return issues;
}

export function hasErrors(issues: Issue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

/** Parse and validate in one step. Throws on either kind of failure. */
export function parseProject(input: unknown, options: ValidateOptions = {}): Project {
  const project = Project.parse(input);
  const issues = validateProject(project, options);
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      `Invalid EvoCut project:\n${errors.map((e) => `  [${e.code}] ${e.message}`).join('\n')}`,
    );
  }
  return project;
}
