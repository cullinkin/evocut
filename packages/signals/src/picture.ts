/**
 * How much the picture is moving, per frame, for the whole recording.
 *
 * ## Why this is not `motion.ts`
 *
 * `motion.ts` answers one question — *is this shot locked off?* — from a handful of frames
 * differenced against each other, and it is right to be crude: it feeds a model deciding
 * whether a slow push-in would suit a shot.
 *
 * This answers a different question, asked by a person: *when does the thing happen?* A
 * knife going into a box seal is four frames long. Nothing sampled every few seconds can
 * see it, and nothing that requires decoding frames can be computed on a phone against a
 * multi-gigabyte recording — the version that tried cost whole seconds of frozen interface.
 *
 * The container already knows. An inter-coded frame *is* a description of what changed
 * since the last one, and its length in bytes is that description's length. Reading the
 * sample table gives the length of every frame in the recording for the price of the index.
 *
 * ## The shape of the answer
 *
 * A value per frame, on a uniform grid, so the drawing code can walk it the same way it
 * walks the loudness envelope — and, as with loudness, the numbers stay as they were
 * measured. Whoever draws them picks the scale, because "how loud is loud here" and "how
 * busy is busy here" are both questions about a particular recording rather than about
 * bytes or decibels.
 */

/** What a container's sample table says about each frame. Structural, so nothing depends on the demuxer. */
export interface FrameWeights {
  /** The commonest interval between frames, in microseconds. */
  hopUs: number;
  /** Encoded size of each frame in bytes, in presentation order. */
  sizes: number[];
  /** Presentation time of each frame within the source, in microseconds. */
  times: number[];
  /** True where the frame is a keyframe. */
  sync: boolean[];
}

export interface PictureSignals {
  /** Spacing between measurements, in microseconds: one frame of the recording. */
  hopUs: number;
  /** Encoded bytes per hop, with keyframes bridged. */
  weight: number[];
  /** The busiest hop, in bytes. Everything else is easier to read against it. */
  peakBytes: number;
  /** The typical hop — what "nothing much happening" weighs on this recording. */
  medianBytes: number;
  /**
   * True when every frame is a keyframe.
   *
   * Then `weight` is the complexity of each picture rather than the change between two, and
   * it is not a movement signal at all. Screen recordings and some cameras do this. Said
   * out loud so a caller can decline to draw it rather than drawing something misleading.
   */
  allIntra: boolean;
}

/** Guard against a table that claims a nonsense frame rate. */
const MIN_HOP_US = 1_000;
const MAX_HOP_US = 1_000_000;

export function analyzePicture(weights: FrameWeights): PictureSignals | null {
  const { sizes, times, sync } = weights;
  if (sizes.length < 2 || times.length !== sizes.length) return null;

  const hopUs = Math.round(Math.min(MAX_HOP_US, Math.max(MIN_HOP_US, weights.hopUs)));
  const allIntra = sync.every(Boolean);
  const measured = allIntra ? sizes.slice() : bridgeKeyframes(sizes, sync);

  /*
    Resampled onto a uniform grid rather than kept per sample.

    Phones record at a variable rate — a frame dropped in low light, a run of doubled
    durations when it got hot — so the samples are not evenly spaced, and a drawing routine
    that assumed they were would put the busy part of a shot in the wrong place. A gap
    holds the last value it had, which is what a repeated frame means anyway.
  */
  const span = times.at(-1)! - times[0]!;
  const slots = Math.max(1, Math.floor(span / hopUs) + 1);
  const weight = new Array<number>(slots).fill(0);
  let cursor = 0;
  let held = measured[0] ?? 0;
  for (let slot = 0; slot < slots; slot += 1) {
    const at = times[0]! + slot * hopUs;
    while (cursor < times.length && times[cursor]! <= at + hopUs / 2) {
      held = measured[cursor]!;
      cursor += 1;
    }
    weight[slot] = Math.round(held);
  }

  const sorted = [...weight].sort((a, b) => a - b);
  return {
    hopUs,
    weight,
    peakBytes: sorted.at(-1) ?? 0,
    medianBytes: sorted[Math.floor(sorted.length / 2)] ?? 0,
    allIntra,
  };
}

/**
 * Replace each keyframe's size with what the frames either side of it weigh.
 *
 * A keyframe is a whole picture, tens of times the size of the differences around it, and
 * it lands every second or two whether or not anything is happening. Left in, the curve is
 * a comb of spikes on a fixed beat — which looks exactly like rhythm and is not.
 */
function bridgeKeyframes(sizes: number[], sync: boolean[]): number[] {
  const out = sizes.slice();
  for (let index = 0; index < out.length; index += 1) {
    if (!sync[index]) continue;

    let before = index - 1;
    while (before >= 0 && sync[before]) before -= 1;
    let after = index + 1;
    while (after < out.length && sync[after]) after += 1;

    const left = before >= 0 ? sizes[before]! : null;
    const right = after < out.length ? sizes[after]! : null;
    // A track that is keyframes all the way to one end borrows from the other; one with no
    // inter-coded frames at all never reaches here.
    out[index] = left !== null && right !== null ? (left + right) / 2 : (left ?? right ?? 0);
  }
  return out;
}
