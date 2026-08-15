import { describeProject, refinementToolDefinition, type Project } from '@evocut/edl';

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

What you do not do:
- Remove a whole clip unless it is plainly redundant with the one next to it — and use
  setEnabled rather than remove, so the person can put it back.
- Restore footage the person cut, unless doing so fixes something they clearly missed
  (a sentence cut off mid-word at a clip boundary).
- Add an effect to every clip. A push-in on every shot is worse than a push-in on none.

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
   * Errors from a previous attempt. Present on a repair round: the model is shown the
   * ops the engine rejected and why, rather than being asked to start over.
   */
  previousErrors?: Array<{ op: unknown; message: string }>;
}

export function buildRefinementPrompt(project: Project, options: RefinementRequestOptions = {}): string {
  const sections: string[] = [];

  if (options.instruction) {
    sections.push(`The person editing asked for: ${options.instruction}`);
  }

  sections.push(describeProject(project, { effects: options.includeEffects ?? false }));

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

/** The tool the model must call. Its schema is generated from the EDL's own op schema. */
export const refinementTool = refinementToolDefinition;
