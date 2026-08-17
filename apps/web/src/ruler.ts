import { formatTimecode, type Rational } from '@evocut/edl';

/**
 * What the timeline ruler draws, at any zoom.
 *
 * ## Why frames
 *
 * The old ruler counted in seconds and stopped there: its finest step was half a second, so
 * zooming past "one second fills the screen" produced a ruler reading `0:00` and `0:01` and
 * nothing in between. That is precisely the zoom at which the ruler starts to matter — you
 * do not zoom that far in to find a shot, you zoom that far in to decide *which frame* a cut
 * lands on — and it is the zoom at which the old one had nothing to say.
 *
 * So below a second the ladder counts frames, exactly the way every editor does: the second
 * boundary keeps its timecode, and the marks inside it are numbered `15f`, `10f`, `5f` as
 * you go further in.
 *
 * ## The ladder
 *
 * Sub-second steps are *divisors of the frame rate*, which is what makes the progression
 * read as halves, then thirds, then sixths rather than as arbitrary numbers: at 30fps the
 * rungs are 15f, 10f, 6f, 5f, 3f, 2f, 1f, and at 60fps they are 30f, 20f, 15f, 12f, 10f and
 * so on. A step that did not divide the rate would put labels at 8f, 16f, 24f, 32f — walking
 * across the second boundary and landing nowhere twice.
 *
 * Above a second the rungs are the familiar 1, 2, 5, 10, 15, 30, 60… because a ruler over a
 * two-minute assembly is for orientation and wants round numbers.
 *
 * ## Two spacings, because the two halves of the ladder are read differently
 *
 * A timecode label is read one at a time — you glance at `0:45` to know where you are — so
 * they can sit close together. Frame numbers are read as a *scale*: what you want is the
 * grid, with enough numbers on it to know which frame you are counting from. Numbering every
 * frame at that zoom would be noise laid over the thing you are trying to see.
 *
 * So frame labels are spaced much further apart than second labels, and the precision comes
 * from an unlabelled tick on every frame — which appears as soon as frames are far enough
 * apart to be distinguishable, before the numbers do.
 *
 * ## Non-integer rates
 *
 * Positions come from the exact rational, so on a 30000/1001 recording the ticks land on
 * real frame boundaries rather than drifting a frame out by the end of a two-minute take.
 * The *labels* count 30 frames to a second, which is non-drop timecode and is what an editor
 * expects to read.
 */
export interface RulerTick {
  /** Position on the output timeline, in microseconds. */
  us: number;
  /** Absolute frame index from time zero. */
  frame: number;
  /** The text to draw, or null for an unlabelled frame mark. */
  label: string | null;
}

export interface RulerPlan {
  ticks: RulerTick[];
  /** Frames between labels — which rung of the ladder is in use. */
  stepFrames: number;
  /** True when every frame is drawn, labelled or not. */
  frameGrid: boolean;
}

/** Pixels a *timecode* label needs to itself. */
const SECOND_LABEL_PX = 64;
/**
 * Pixels a *frame* label needs to itself.
 *
 * Much wider than a timecode label, and deliberately. This one number decides the whole
 * progression, and it is set to the value that produces the one an editor expects: on a
 * phone, `15f` alone in the middle of the second at the zoom where a second fills the
 * screen, then `10f`/`20f` a zoom in, then fifths, then sixths — halves, thirds, sixths,
 * rather than six numbers crowding a second that is only just wide enough to hold them.
 * At 60fps the same zooms give `30f`, then `20f`/`40f`, for the same reason.
 */
const FRAME_LABEL_PX = 150;
/** Below this a frame grid is a grey band rather than a set of marks, so it is not drawn. */
const FRAME_TICK_PX = 9;

export interface RulerRequest {
  /** Window to fill, in microseconds. Only what is on screen is worth building. */
  fromUs: number;
  toUs: number;
  /** The end of the edit; nothing is drawn past it. */
  totalUs: number;
  pxPerSecond: number;
  frameRate: Rational;
}

export function planRuler({ fromUs, toUs, totalUs, pxPerSecond, frameRate }: RulerRequest): RulerPlan {
  const fps = frameRate.num / frameRate.den;
  const safeFps = Number.isFinite(fps) && fps >= 1 && fps <= 1000 ? fps : 30;
  /** What the labels count to a second. Non-drop, so 29.97 counts thirty. */
  const nominal = Math.round(safeFps);
  const frameUs = 1_000_000 / safeFps;
  const framePx = (frameUs / 1_000_000) * pxPerSecond;

  const rungs = ladder(nominal);
  const stepFrames =
    rungs.find((step) => framePx * step >= (step < nominal ? FRAME_LABEL_PX : SECOND_LABEL_PX)) ??
    rungs.at(-1)!;

  // Only worth a grid when there is something between the labels to divide.
  const frameGrid = stepFrames > 1 && framePx >= FRAME_TICK_PX;
  const gridStep = frameGrid ? 1 : stepFrames;

  const first = Math.max(0, Math.floor(Math.max(0, fromUs) / frameUs));
  // Nudged, because a frame duration is rarely exact in binary: one second at 30fps divides
  // into 29.999999999999996 frames, and a plain floor would drop the mark on every whole
  // second — the one mark on the ruler that must never be missing.
  const last = Math.floor(Math.min(toUs, totalUs) / frameUs + 1e-6);

  const ticks: RulerTick[] = [];
  for (let frame = first - (first % gridStep); frame <= last; frame += gridStep) {
    const us = Math.round(frame * frameUs);
    if (us > totalUs) break;
    ticks.push({
      us,
      frame,
      label: frame % stepFrames === 0 ? labelFor(frame, nominal, us) : null,
    });
  }
  return { ticks, stepFrames, frameGrid };
}

/** A second boundary keeps its timecode; everything inside one is counted in frames. */
function labelFor(frame: number, nominal: number, us: number): string {
  const within = frame % nominal;
  if (within === 0) return formatTimecode(us, undefined, { compact: true }).replace(/\.\d+$/, '');
  return `${within}f`;
}

/**
 * Every step the ruler may use, in frames, coarsening upward.
 *
 * Divisors of the frame rate below a second — so the marks always sit on a whole fraction
 * of one — and round numbers of seconds above it.
 */
export function ladder(nominal: number): number[] {
  const steps: number[] = [];
  for (let frames = 1; frames <= nominal; frames += 1) {
    if (nominal % frames === 0) steps.push(frames);
  }
  for (const seconds of [2, 5, 10, 15, 30, 60, 120, 300, 600, 1800]) {
    steps.push(seconds * nominal);
  }
  return steps;
}
