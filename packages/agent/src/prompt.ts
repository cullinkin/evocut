import {
  describeProject,
  formatTimecode,
  refinementToolDefinition,
  timelineDuration,
  type Project,
} from '@evocut/edl';
import { describeSignals, type SourceSignals } from '@evocut/signals';

/**
 * Prompt construction for the refinement pass.
 *
 * The pass is deliberately narrow: the human has already decided what the video is
 * *about* by choosing which footage survives. The model is not being asked to re-edit,
 * and the prompt says so — an open-ended "make this better" invites it to relitigate the
 * coarse pass, which is both wrong and expensive.
 */

export const REFINEMENT_SYSTEM_PROMPT = `You are the refinement pass of EvoCut, a video editor.

A person has already made the coarse pass: they watched their footage and kept only the
parts worth using. That judgement is settled. Your job is to make the kept material play
well — not to reconsider what it should contain.

What you do:
- Tighten the joins. Coarse cuts are made by dragging on a phone, so they usually include
  a breath, a stray word, or a half-second of stillness at each end. Trim those.
- Cut dead air inside a clip: long pauses, a stall while the speaker finds a word.
- Speed up passages where nothing is developing (a walk-over, a wait for something to
  load). Between 1.25x and 2x reads as intentional; beyond that reads as a glitch.
- Add motion to static shots. A slow push-in or drift over a locked-off talking head keeps
  the frame alive. Keep it under about 1.3x scale unless there is a reason.
- Balance obvious loudness differences between clips.
- Give the hits their moment. Where a measured transient marks something landing, hold on
  it: a brief slowdown into it, or a push-in that arrives on it, rather than a cut across
  it. One or two of these in a video is emphasis; one on every hit is a music video.

Using the frames, when you have them:
- They are the footage. Say what you see. "Three clips of the same pack being opened, this
  is the sharpest" is an edit decision; "tightened the join" is a guess with a haircut.
- Redundancy is what you are best placed to find and the person is worst placed to see —
  they filmed it, so every take feels different to them. If two shots show the same thing,
  say which one survives and why.
- A shot with nothing in it is a shot to cut. A minute of a table between two moments is
  not pacing, it is a minute of a table.
- Do not narrate the frames back. The rationale is one sentence and it exists to be judged.

Using the signals:
- They are measurements, not descriptions. A "hit" is a sudden rise in level — something
  struck or landed or was said hard. A "quiet" span is genuinely quiet. "Still" means the
  picture is barely changing.
- Cite them. If a signal is why you made an edit, say which one in the rationale: "quiet
  from 4.1s to 5.4s". A rationale that could have been written without looking at the
  footage is not a rationale.
- They are incomplete. Nothing here tells you what is being said, or what is in frame. If
  the signals do not support an edit, do not make it up to fill the gap — leave it out.

When a target length is given:
- It changes the job. Tightening joins recovers seconds; a target that is minutes away can
  only be met by dropping whole shots, so drop them. Use setEnabled rather than remove, so
  the person can put any of them back with one tap.
- Say which shots you dropped and why those and not others. "Redundant with the shot after
  it", "nothing happens for the last twenty seconds of it" — the reason is what the person
  is judging, and on a whole-shot cut it is the only thing they can judge.
- Do not silently give up on the number. If the signals do not support cutting far enough,
  get as close as you honestly can and say in your summary how much is left and where you
  think it has to come from.

What you do not do:
- Remove a whole clip unless it is plainly redundant with the one next to it, or a target
  length requires it — and use setEnabled rather than remove, so the person can put it back.
- Restore footage the person cut, unless doing so fixes something they clearly missed
  (a sentence cut off mid-word at a clip boundary).
- Add an effect to every clip. A push-in on every shot is worse than a push-in on none.
- Grade the picture. setColor exists in the schema because the person adjusts colour and
  tone themselves, on a screen where they can see the result; you cannot see the footage,
  so a grade from you would be a guess dressed as a decision. Leave colour alone.

Rules:
- Reply by calling propose_edits. Do not describe edits in prose.
- Every op needs a rationale of one short sentence, in plain language, saying what you
  heard or saw that prompted it. "clip starts on an inhale" — not "improves pacing".
- All times are integer microseconds. Times are on the output timeline unless the field
  name says "source".
- Reference clips by the ids in the timeline below. Do not invent ids.
- A split creates a new clip id for the right-hand half. If you split and then want to
  edit that half in the same batch, set newClipId yourself so you can name it.
- If you are not confident about an edit, leave it out. A short list of edits the person
  accepts is worth more than a long list they have to undo.`;

export interface RefinementRequestOptions {
  /** Free-text steer from the user, e.g. "keep it punchy, it's for a short". */
  instruction?: string;
  /** Include per-clip effect summaries. Useful on a second pass. */
  includeEffects?: boolean;
  /**
   * What the footage actually sounds and looks like, by source id.
   *
   * Optional, and the pass works without it — but a model given only the timeline is
   * being asked to guess where the interesting moments are, and it will oblige.
   */
  signals?: Map<string, SourceSignals>;
  /**
   * Errors from a previous attempt. Present on a repair round: the model is shown the
   * ops the engine rejected and why, rather than being asked to start over.
   */
  previousErrors?: Array<{ op: unknown; message: string }>;
  /**
   * Frames from the footage, by clip, in order.
   *
   * The one thing that turns this from a spreadsheet exercise into editing. Without them
   * the model knows how long each clip is and where a transient landed, and nothing about
   * what is *in* the shot — so it cannot know that four clips are the same card being
   * opened, or that the sixty-second one is a wide of nothing. It said so itself on a real
   * pass: "no level, quiet or hit data was returned for the long middle clips, so I left
   * their interiors alone rather than guess."
   *
   * Absent by default, and the pass works without it. Present only when the person has
   * turned frames on, because these are pictures of their life leaving their device.
   */
  frames?: ClipFrames[];
}

/** Frames belonging to one clip. `data` is base64, without a data-URL prefix. */
export interface ClipFrames {
  clipId: string;
  /** Where the clip sits in the edit, for the label. 1-based. */
  index: number;
  total: number;
  /** Output start and length, both in microseconds. */
  startUs: number;
  durationUs: number;
  frames: Array<{ mediaType: string; data: string }>;
}

/**
 * A piece of the request: either words or a picture.
 *
 * The prompt is a list rather than a string because the frames have to sit *next to* the
 * clip they came from. A block of a hundred images after a block of text is a puzzle the
 * model has to solve before it can start editing, and it will solve it wrong.
 */
export type PromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string };

export function buildRefinementPrompt(project: Project, options: RefinementRequestOptions = {}): string {
  const sections: string[] = [];

  if (options.instruction) {
    sections.push(`The person editing asked for: ${options.instruction}`);
  }

  /*
    The target length, stated as arithmetic.

    This is the one instruction the model can check its own work against: every clip's
    length is in the description below, so "cut to 1:10" is a sum it can actually do,
    where the same words inside a free-text brief are a mood. It is also the instruction
    that turns a polishing pass into a selection pass — without a number there is no
    reason to drop a whole shot, and dropping whole shots is the only way a nine-minute
    assembly becomes a three-minute video.
  */
  if (project.targetDurationUs) {
    const current = timelineDuration(project.timeline);
    const over = current - project.targetDurationUs;
    sections.push(
      [
        `Target length: ${formatTimecode(project.targetDurationUs)} (${project.targetDurationUs}us).`,
        `This cut currently runs ${formatTimecode(current)} (${current}us), which is ` +
          `${formatTimecode(Math.abs(over))} ${over > 0 ? 'over' : 'under'}.`,
        over > 0
          ? 'Getting there means dropping or shortening whole shots, not only tightening joins. ' +
            'Say in your summary how much you removed and where you think the rest has to come from.'
          : 'There is room; do not pad it.',
      ].join(' '),
    );
  }

  sections.push(describeProject(project, { effects: options.includeEffects ?? false }));

  if (options.signals && options.signals.size > 0) {
    const measured = describeSignals(project.timeline, options.signals);
    if (measured) sections.push(measured);
  }

  if (options.previousErrors?.length) {
    sections.push(
      [
        'Your previous batch was applied, but these ops were rejected. Everything else went',
        'through, so do not repeat the edits that succeeded — send only replacements for these:',
        '',
        ...options.previousErrors.map((e) => `- ${JSON.stringify(e.op)}\n  rejected: ${e.message}`),
      ].join('\n'),
    );
  }

  sections.push('Call propose_edits with your refinements.');
  return sections.join('\n\n');
}

/**
 * The same prompt, with the footage in it.
 *
 * Falls back to exactly one text block when there are no frames, so the request the
 * transport builds is byte-identical to the one it built before this existed.
 *
 * The closing instruction is moved to the very end, after the pictures. A request that
 * says "now call the tool" and then shows a hundred images has buried its own instruction.
 */
export function buildRefinementContent(
  project: Project,
  options: RefinementRequestOptions = {},
): PromptBlock[] {
  const whole = buildRefinementPrompt(project, options);
  if (!options.frames?.length) return [{ type: 'text', text: whole }];

  const closing = 'Call propose_edits with your refinements.';
  const blocks: PromptBlock[] = [{ type: 'text', text: whole.replace(new RegExp(`\n\n${closing}$`), '') }];

  blocks.push({
    type: 'text',
    text: [
      'Frames from the footage follow. Each label names a clip by the id used above; the',
      'images after a label are from that clip, evenly spaced across it, in order.',
      '',
      'This is what you have that a list of durations does not. Use it to judge what a shot',
      'is *of*: which clips repeat each other, which one is the best take of a moment that',
      'was filmed three times, where the payoff actually lands, and which shots are setup',
      'that can go. A rationale that names what is in the frame — "same pack opening as the',
      'clip before it, and this one is out of focus" — is the kind this pass exists for.',
    ].join('\n'),
  });

  for (const clip of options.frames) {
    blocks.push({
      type: 'text',
      text:
        `${clip.clipId} — clip ${clip.index} of ${clip.total}, ` +
        `at ${formatTimecode(clip.startUs, undefined, { compact: true })}, ` +
        `${(clip.durationUs / 1_000_000).toFixed(1)}s long`,
    });
    for (const frame of clip.frames) {
      blocks.push({ type: 'image', mediaType: frame.mediaType, data: frame.data });
    }
  }

  blocks.push({ type: 'text', text: closing });
  return blocks;
}

/** Just the words out of a request, for tests and for anything that logs what was asked. */
export function textOf(content: PromptBlock[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n');
}

/** The tool the model must call. Its schema is generated from the EDL's own op schema. */
export const refinementTool = refinementToolDefinition;
