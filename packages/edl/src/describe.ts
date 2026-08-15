import { outputDuration, sourceDuration, clipEnd } from './schema/clip.js';
import { findClip, timelineDuration, type Timeline } from './schema/timeline.js';
import type { Project } from './schema/project.js';
import type { ColorValue, Effect } from './schema/effects.js';
import type { Op } from './schema/ops.js';
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

/**
 * Plain-language description of a single op, for the review screen.
 *
 * A person deciding whether to accept an edit needs to know what it does to *their* video,
 * not what fields it sets. "Trim 0.4s off the head of clip 2" is reviewable;
 * `{"op":"trim","clipId":"clp_x","sourceIn":2400000}` is not — and a review that is too
 * much work to do carefully produces a worthless label.
 *
 * Takes the timeline the op will apply to, so it can name clips by their position rather
 * than their id. Falls back gracefully when the clip is not found: a later op in a batch
 * may target something an earlier one created.
 */
export function describeOp(op: Op, timeline?: Timeline): string {
  const named = (clipId: string) => {
    if (!timeline) return clipId;
    const found = findClip(timeline, clipId);
    if (!found) return clipId;
    return `clip ${found.index + 1}${found.clip.label ? ` (${found.clip.label})` : ''}`;
  };
  const clip = (clipId: string) => (timeline ? findClip(timeline, clipId)?.clip : undefined);
  const short = (us: number) => formatTimecode(Math.abs(us), undefined, { compact: true });

  switch (op.op) {
    case 'trim': {
      const target = clip(op.clipId);
      const parts: string[] = [];
      if (op.sourceIn !== undefined && target) {
        const delta = op.sourceIn - target.sourceIn;
        if (delta !== 0) parts.push(`${delta > 0 ? 'trim' : 'extend'} ${short(delta)} ${delta > 0 ? 'off' : 'onto'} the head`);
      } else if (op.sourceIn !== undefined) {
        parts.push(`set the head to ${short(op.sourceIn)}`);
      }
      if (op.sourceOut !== undefined && target) {
        const delta = target.sourceOut - op.sourceOut;
        if (delta !== 0) parts.push(`${delta > 0 ? 'trim' : 'extend'} ${short(delta)} ${delta > 0 ? 'off' : 'onto'} the tail`);
      } else if (op.sourceOut !== undefined) {
        parts.push(`set the tail to ${short(op.sourceOut)}`);
      }
      const what = parts.length > 0 ? parts.join(' and ') : 'adjust';
      return `${sentence(what)} of ${named(op.clipId)}`;
    }

    case 'split':
      return `Split ${named(op.clipId)} at ${short(op.at)}`;

    case 'remove':
      return `Delete ${named(op.clipId)}`;

    case 'setEnabled':
      return op.enabled ? `Bring back ${named(op.clipId)}` : `Drop ${named(op.clipId)}`;

    case 'move':
      return `Move ${named(op.clipId)} to position ${op.toIndex + 1}`;

    case 'setSpeed': {
      const verb = op.speed > 1 ? 'Speed up' : 'Slow down';
      return `${verb} ${named(op.clipId)} to ${formatRate(op.speed)}`;
    }

    case 'addEffect':
      return `${describeNewEffect(op.effect)} on ${named(op.clipId)}`;

    case 'removeEffect':
      return `Remove an effect from ${named(op.clipId)}`;

    case 'setAudio': {
      if (op.audio.mute === true) return `Mute ${named(op.clipId)}`;
      if (op.audio.mute === false) return `Unmute ${named(op.clipId)}`;
      if (op.audio.gain !== undefined) {
        return `Set ${named(op.clipId)} volume to ${Math.round(op.audio.gain * 100)}%`;
      }
      return `Adjust audio on ${named(op.clipId)}`;
    }

    case 'setColor':
      return op.color === null
        ? `Clear the colour adjustment on ${named(op.clipId)}`
        : `Adjust colour on ${named(op.clipId)}: ${describeColor(op.color)}`;

    case 'setLabel':
      return `Label ${named(op.clipId)} "${op.label}"`;

    case 'insertClip':
      return `Restore ${short(op.sourceOut - op.sourceIn)} of footage from ${op.sourceId}`;
  }
}

function describeNewEffect(effect: Effect): string {
  switch (effect.type) {
    case 'transform': {
      const first = effect.keyframes[0]!.value;
      const last = effect.keyframes.at(-1)!.value;
      if (effect.keyframes.length === 1) return `Reframe at ${formatRate(first.scale)}`;
      if (last.scale > first.scale) return `Push in from ${formatRate(first.scale)} to ${formatRate(last.scale)}`;
      if (last.scale < first.scale) return `Pull out from ${formatRate(first.scale)} to ${formatRate(last.scale)}`;
      return 'Add a slow pan';
    }
    case 'crop':
      return 'Crop the frame';
    case 'volume':
      return 'Ride the volume';
    case 'opacity':
      return 'Fade';
    case 'color':
      return `Adjust colour: ${describeColor(effect.value)}`;
  }
}

/**
 * A grade in words, naming only what was actually moved.
 *
 * Six controls listed every time — five of them at zero — is a sentence nobody reads. The
 * two or three that were touched are the whole content of the change.
 */
function describeColor(value: ColorValue): string {
  const moved = (Object.entries(value) as Array<[keyof ColorValue, number]>)
    .filter(([, amount]) => amount !== 0)
    .map(([name, amount]) => `${name} ${amount > 0 ? '+' : ''}${Math.round(amount * 100)}`);
  return moved.length > 0 ? moved.join(', ') : 'nothing';
}

function formatRate(value: number): string {
  return `${Number(value.toFixed(2))}×`;
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
