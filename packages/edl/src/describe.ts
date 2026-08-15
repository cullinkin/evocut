import { outputDuration, sourceDuration, clipEnd } from './schema/clip.js';
import { timelineDuration, type Timeline } from './schema/timeline.js';
import type { Project } from './schema/project.js';
import { formatTimecode } from './time.js';

/**
 * Render a timeline as compact text for an LLM prompt.
 *
 * Not JSON. Feeding the model the raw EDL wastes most of the context on ids, defaults, and
 * punctuation, and — worse — invites it to reply with a whole edited document instead of
 * ops. A tabular summary keeps clip ids prominent (they are what ops address), puts every
 * time in both timecode and microseconds (timecode for reasoning, microseconds for the op
 * it has to emit), and simply has no slot for it to rewrite.
 */
export interface DescribeOptions {
  /** Include per-clip effect summaries. Off for the first refinement pass. */
  effects?: boolean;
  /** Include disabled clips, marked as such. */
  includeDisabled?: boolean;
}

export function describeTimeline(timeline: Timeline, options: DescribeOptions = {}): string {
  const lines: string[] = [];
  const total = timelineDuration(timeline);

  lines.push(
    `Timeline ${timeline.id} — ${formatTimecode(total)} (${total}us), ` +
      `${timeline.resolution.width}x${timeline.resolution.height} @ ` +
      `${(timeline.frameRate.num / timeline.frameRate.den).toFixed(3)}fps`,
  );

  for (const track of timeline.tracks) {
    const visible = options.includeDisabled ? track.clips : track.clips.filter((c) => c.enabled);
    lines.push('');
    lines.push(`Track ${track.id} (${track.kind}${track.locked ? ', locked' : ''}) — ${visible.length} clips`);

    if (visible.length === 0) {
      lines.push('  (empty)');
      continue;
    }

    for (const [index, clip] of visible.entries()) {
      const out = outputDuration(clip);
      const parts = [
        `${String(index).padStart(2, ' ')}.`,
        clip.id,
        `timeline ${formatTimecode(clip.start)}–${formatTimecode(clipEnd(clip))}`,
        `(${clip.start}–${clipEnd(clip)}us)`,
        `source ${clip.sourceId} ${formatTimecode(clip.sourceIn)}–${formatTimecode(clip.sourceOut)}`,
        `(${clip.sourceIn}–${clip.sourceOut}us)`,
        `len ${formatTimecode(out)}`,
      ];
      if (clip.speed !== 1) parts.push(`speed ${clip.speed}x`);
      if (!clip.enabled) parts.push('DISABLED');
      if (clip.audio.mute) parts.push('muted');
      if (clip.label) parts.push(`"${clip.label}"`);
      lines.push(`  ${parts.join('  ')}`);

      if (options.effects && clip.effects.length > 0) {
        for (const effect of clip.effects) {
          lines.push(`      effect ${effect.id} ${effect.type}${describeEffect(effect)}`);
        }
      }

      // Discontinuities in the source are where the human made a coarse cut. They are the
      // most useful thing on this page for a refinement pass: the model is being asked to
      // clean up these joins, so it should not have to derive them.
      const next = visible[index + 1];
      if (next && next.sourceId === clip.sourceId && next.sourceIn !== clip.sourceOut) {
        const gap = next.sourceIn - clip.sourceOut;
        lines.push(
          `      ^ coarse cut: ${gap > 0 ? 'dropped' : 'overlapped'} ${formatTimecode(Math.abs(gap))} of source here`,
        );
      }
    }
  }

  return lines.join('\n');
}

function describeEffect(effect: { type: string; keyframes?: Array<{ t: number }>; rect?: unknown }): string {
  if (effect.keyframes) {
    const first = effect.keyframes[0]!;
    const last = effect.keyframes.at(-1)!;
    return `, ${effect.keyframes.length} keyframes ${first.t}–${last.t}us`;
  }
  return '';
}

/** Timeline description plus the source inventory the model needs to insert footage. */
export function describeProject(project: Project, options: DescribeOptions = {}): string {
  const sources = project.sources.map((source) => {
    const dims = source.video ? `${source.video.width}x${source.video.height}` : 'no video';
    return `  ${source.id}  ${source.name ?? '(unnamed)'}  ${formatTimecode(source.duration)} (${source.duration}us)  ${dims}`;
  });

  return [
    `Project ${project.id} "${project.name}" — stage: ${project.stage}`,
    '',
    'Sources:',
    ...(sources.length > 0 ? sources : ['  (none)']),
    '',
    describeTimeline(project.timeline, options),
  ].join('\n');
}

/** One-line summary of a clip, for review UI and error messages. */
export function describeClip(clip: Parameters<typeof outputDuration>[0] & { id: string }): string {
  return `${clip.id} (${formatTimecode(sourceDuration(clip))} source, ${formatTimecode(outputDuration(clip))} out)`;
}
